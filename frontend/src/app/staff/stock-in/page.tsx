"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { shortDate, today } from "@/lib/format";
import { Stamp } from "@/components/Stamp";
import type { Ingredient, Paginated, StockInItem, StockInRecord } from "@/lib/types";

interface EditLine {
  ingredient: number | null;
  ingredient_name?: string;
  raw_extracted_text: string;
  source: "SLIP_EXTRACTED" | "MANUAL";
  unit_captured: "PACK" | "PIECE";
  extracted_quantity: string | null;
  confirmed_quantity: string;
  pack_definition: number | null;
  wasUnrecognized: boolean;
  yieldPieces?: string;
  yieldCost?: string;
}

export default function StockInPage() {
  const { user } = useAuth();
  const outlet = user?.outlet ?? 1;
  const fileRef = useRef<HTMLInputElement>(null);
  const aliasedRef = useRef<Set<string>>(new Set());

  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [records, setRecords] = useState<StockInRecord[]>([]);
  const [draft, setDraft] = useState<StockInRecord | null>(null);
  const [lines, setLines] = useState<EditLine[]>([]);
  const [busy, setBusy] = useState<string>("");
  const [msg, setMsg] = useState("");

  const ingById = useMemo(() => {
    const m = new Map<number, Ingredient>();
    ingredients.forEach((i) => m.set(i.id, i));
    return m;
  }, [ingredients]);

  function toEditLines(items: StockInItem[]): EditLine[] {
    return items.map((it) => ({
      ingredient: it.ingredient,
      ingredient_name: it.ingredient_name,
      raw_extracted_text: it.raw_extracted_text ?? "",
      source: it.source,
      unit_captured: it.unit_captured,
      extracted_quantity: it.extracted_quantity ?? null,
      confirmed_quantity: String(it.confirmed_quantity),
      pack_definition: it.pack_definition,
      wasUnrecognized: it.ingredient == null,
    }));
  }

  async function refresh() {
    const [ing, r] = await Promise.all([
      api<Paginated<Ingredient>>("/ingredients/?active=true"),
      api<Paginated<StockInRecord>>(`/stock-in/?outlet=${outlet}`),
    ]);
    setIngredients(ing.results);
    setRecords(r.results);
    return r.results;
  }
  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outlet]);

  async function startOrResume() {
    setMsg("");
    const existing = records.find((r) => r.status === "DRAFT");
    if (existing) {
      setDraft(existing);
      setLines(toEditLines(existing.items));
      return;
    }
    setBusy("new");
    try {
      const rec = await api<StockInRecord>("/stock-in/", {
        method: "POST",
        body: JSON.stringify({ outlet, stock_in_date: today(), items: [] }),
      });
      setDraft(rec);
      setLines([]);
    } finally {
      setBusy("");
    }
  }

  async function onSlipChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !draft) return;
    setBusy("upload");
    setMsg("");
    try {
      const form = new FormData();
      form.append("slip_image", file);
      const rec = await api<StockInRecord>(`/stock-in/${draft.id}/upload-slip/`, {
        method: "POST",
        body: form,
      });
      setDraft(rec);
      setMsg("Slip attached. Tap “Auto-read from slip”.");
    } finally {
      setBusy("");
    }
  }

  async function extract() {
    if (!draft) return;
    setBusy("extract");
    setMsg("");
    try {
      const rec = await api<StockInRecord & { extracted_count: number }>(
        `/stock-in/${draft.id}/extract/`,
        { method: "POST" }
      );
      setDraft(rec);
      setLines(toEditLines(rec.items));
      const unresolved = rec.items.filter((i) => i.ingredient == null).length;
      setMsg(
        rec.extracted_count > 0
          ? `Read ${rec.extracted_count} line(s)${unresolved ? ` · ${unresolved} unrecognized — match them below` : ""}.`
          : "Couldn’t read any lines. Add them manually below."
      );
    } catch (err) {
      setMsg(
        err instanceof ApiError && err.status === 503
          ? "Auto-read is unavailable — enter lines manually."
          : "Extraction failed. Enter lines manually."
      );
    } finally {
      setBusy("");
    }
  }

  function addManualLine() {
    const ing = ingredients[0];
    setLines((ls) => [
      ...ls,
      {
        ingredient: ing?.id ?? null,
        ingredient_name: ing?.name,
        raw_extracted_text: "",
        source: "MANUAL",
        unit_captured: ing?.active_pack ? "PACK" : "PIECE",
        extracted_quantity: null,
        confirmed_quantity: "1",
        pack_definition: ing?.active_pack?.id ?? null,
        wasUnrecognized: false,
      },
    ]);
  }

  function updateLine(i: number, patch: Partial<EditLine>) {
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  function setLineIngredient(i: number, ingredientId: number) {
    const ing = ingById.get(ingredientId);
    updateLine(i, {
      ingredient: ingredientId,
      ingredient_name: ing?.name,
      pack_definition: ing?.active_pack?.id ?? null,
    });
  }

  function removeLine(i: number) {
    setLines((ls) => ls.filter((_, idx) => idx !== i));
  }

  function lineNeedsYield(l: EditLine) {
    return l.ingredient != null && l.unit_captured === "PACK" && l.pack_definition == null;
  }

  async function persist(): Promise<StockInRecord | null> {
    if (!draft) return null;
    const prepared: EditLine[] = [];
    for (const l of lines) {
      const line = { ...l };
      // Create the pack yield on the spot if a PACK line has no pack yet.
      if (lineNeedsYield(line) && line.yieldPieces) {
        const pack = await api<{ id: number }>("/pack-definitions/", {
          method: "POST",
          body: JSON.stringify({
            ingredient: line.ingredient,
            pieces_per_pack: line.yieldPieces,
            cost_per_pack: line.yieldCost || "0",
            effective_from: today(),
          }),
        });
        line.pack_definition = pack.id;
      }
      // Remember supplier wording so it auto-resolves next time.
      if (line.wasUnrecognized && line.ingredient && line.raw_extracted_text) {
        const key = `${line.ingredient}:${line.raw_extracted_text}`;
        if (!aliasedRef.current.has(key)) {
          await api("/supplier-aliases/", {
            method: "POST",
            body: JSON.stringify({
              ingredient: line.ingredient,
              alias_text: line.raw_extracted_text,
            }),
          }).catch(() => {});
          aliasedRef.current.add(key);
        }
      }
      prepared.push(line);
    }
    const items = prepared
      .filter((l) => Number(l.confirmed_quantity) > 0)
      .map((l) => ({
        ingredient: l.ingredient,
        raw_extracted_text: l.raw_extracted_text,
        source: l.source,
        unit_captured: l.unit_captured,
        extracted_quantity: l.extracted_quantity,
        confirmed_quantity: l.confirmed_quantity,
        pack_definition: l.pack_definition,
      }));
    const rec = await api<StockInRecord>(`/stock-in/${draft.id}/`, {
      method: "PUT",
      body: JSON.stringify({ outlet, stock_in_date: draft.stock_in_date, items }),
    });
    setDraft(rec);
    setLines(toEditLines(rec.items));
    return rec;
  }

  async function save() {
    setBusy("save");
    setMsg("");
    try {
      await persist();
      setMsg("Saved ✓");
    } finally {
      setBusy("");
    }
  }

  async function submit() {
    if (!draft) return;
    setBusy("submit");
    setMsg("");
    try {
      const rec = await persist();
      if (rec && rec.unresolved_count > 0) {
        setMsg(`Resolve ${rec.unresolved_count} line(s) first (unknown ingredient or missing pack yield).`);
        return;
      }
      await api(`/stock-in/${draft.id}/submit/`, { method: "POST" });
      setDraft(null);
      setLines([]);
      setMsg("Submitted for approval ✓");
      refresh();
    } catch {
      setMsg("Submit failed — resolve all lines and add at least one.");
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-xl font-bold">Stock In</h1>
          <p className="text-xs text-ink-soft">Receive ingredients · slip optional</p>
        </div>
        {!draft && (
          <button className="btn btn-primary !px-4 !py-2" disabled={busy === "new"} onClick={startOrResume}>
            {busy === "new" ? "…" : "+ New"}
          </button>
        )}
      </div>

      {draft && (
        <div className="ticket flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <p className="font-mono text-[11px] uppercase tracking-wide text-ink-soft">
              New stock-in · draft #{draft.id}
            </p>
            <button className="font-mono text-[10px] text-ink-soft underline" onClick={() => setDraft(null)}>
              close
            </button>
          </div>

          <div className="flex flex-col gap-2">
            <span className="field-label">Delivery slip</span>
            {draft.slip_image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={draft.slip_image} alt="delivery slip" className="max-h-40 w-full rounded border border-[#d8cdb0] object-contain" />
            ) : null}
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onSlipChosen} />
            <div className="flex gap-2">
              <button className="btn btn-ghost flex-1" disabled={busy === "upload"} onClick={() => fileRef.current?.click()}>
                {busy === "upload" ? "Uploading…" : draft.slip_image ? "Replace slip" : "+ Attach slip"}
              </button>
              <button className="btn btn-primary flex-1" disabled={!draft.slip_image || busy === "extract"} onClick={extract}>
                {busy === "extract" ? "Reading…" : "Auto-read from slip"}
              </button>
            </div>
          </div>

          {/* Editable ingredient lines */}
          <div className="flex flex-col gap-3">
            {lines.map((l, i) => {
              const unrecognized = l.ingredient == null;
              const needYield = lineNeedsYield(l);
              return (
                <div
                  key={i}
                  className={`rounded border px-2.5 py-2 ${
                    unrecognized || needYield ? "border-chili/50 bg-chili/10" : "border-[#d8cdb0] bg-[#fffdf7]"
                  }`}
                >
                  {l.raw_extracted_text && (
                    <p className="mb-1 font-mono text-[10px] text-ink-soft">
                      slip: “{l.raw_extracted_text}”
                    </p>
                  )}
                  {unrecognized ? (
                    <div className="mb-1.5">
                      <span className="font-mono text-[10px] uppercase text-chili">Unrecognized — match it</span>
                      <select
                        className="field-input mt-1"
                        value=""
                        onChange={(e) => setLineIngredient(i, Number(e.target.value))}
                      >
                        <option value="" disabled>
                          Choose ingredient…
                        </option>
                        {ingredients.map((ing) => (
                          <option key={ing.id} value={ing.id}>
                            {ing.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <select
                      className="field-input !px-1.5 !py-1"
                      value={l.ingredient ?? ""}
                      onChange={(e) => setLineIngredient(i, Number(e.target.value))}
                    >
                      {ingredients.map((ing) => (
                        <option key={ing.id} value={ing.id}>
                          {ing.name}
                        </option>
                      ))}
                    </select>
                  )}

                  <div className="mt-1.5 flex items-center gap-1.5">
                    <input
                      className="field-input !px-1.5 !py-1 w-16 text-center"
                      inputMode="decimal"
                      value={l.confirmed_quantity}
                      onChange={(e) => updateLine(i, { confirmed_quantity: e.target.value })}
                    />
                    <select
                      className="field-input !px-1.5 !py-1 w-24"
                      value={l.unit_captured}
                      onChange={(e) => updateLine(i, { unit_captured: e.target.value as "PACK" | "PIECE" })}
                    >
                      <option value="PACK">pack(s)</option>
                      <option value="PIECE">
                        {l.ingredient ? ingById.get(l.ingredient)?.base_unit ?? "piece" : "piece"}
                      </option>
                    </select>
                    <span className="flex-1 text-right font-mono text-[9px] uppercase text-ink-soft">
                      {l.source === "SLIP_EXTRACTED" ? "slip" : "man"}
                    </span>
                    <button className="font-mono text-ink-soft" onClick={() => removeLine(i)}>
                      ✕
                    </button>
                  </div>

                  {needYield && (
                    <div className="mt-1.5 rounded bg-chili/10 px-2 py-1.5">
                      <p className="font-mono text-[10px] text-chili-deep">
                        How many pieces does 1 pack make?
                      </p>
                      <div className="mt-1 flex gap-1.5">
                        <input
                          className="field-input !px-1.5 !py-1 flex-1"
                          placeholder="pcs/pack"
                          inputMode="decimal"
                          value={l.yieldPieces ?? ""}
                          onChange={(e) => updateLine(i, { yieldPieces: e.target.value })}
                        />
                        <input
                          className="field-input !px-1.5 !py-1 flex-1"
                          placeholder="cost/pack ৳"
                          inputMode="decimal"
                          value={l.yieldCost ?? ""}
                          onChange={(e) => updateLine(i, { yieldCost: e.target.value })}
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            <button className="btn btn-ghost" onClick={addManualLine}>
              + Add line manually
            </button>
          </div>

          <div className="flex gap-2">
            <button className="btn btn-ghost flex-1" disabled={busy === "save"} onClick={save}>
              {busy === "save" ? "Saving…" : "Save draft"}
            </button>
            <button className="btn btn-primary flex-1" disabled={busy === "submit" || lines.length === 0} onClick={submit}>
              {busy === "submit" ? "…" : "Submit for approval"}
            </button>
          </div>
        </div>
      )}

      {msg && <p className="font-mono text-xs text-ink-soft">{msg}</p>}

      <div className="flex flex-col gap-3">
        {records.map((r) => (
          <div key={r.id} className="ticket">
            <div className="absolute right-3 top-3">
              <Stamp status={r.status} />
            </div>
            <p className="mb-2 font-mono text-[11px] text-ink-soft">
              {shortDate(r.stock_in_date)} · stock-in #{r.id}
              {r.slip_image ? " · 📎 slip" : ""}
            </p>
            {r.items.map((it) => (
              <div key={it.id} className="ticket-row">
                <span>
                  {it.ingredient_name ?? `“${it.raw_extracted_text}”`} — {it.confirmed_quantity}{" "}
                  {it.unit_captured === "PACK" ? "pack(s)" : it.base_unit}
                  {it.source === "SLIP_EXTRACTED" && (
                    <span className="ml-1 text-[9px] uppercase text-leaf-deep">slip</span>
                  )}
                </span>
                <span className="text-ink-soft">
                  {it.base_unit_quantity} {it.base_unit}
                </span>
              </div>
            ))}
            {r.items.length === 0 && <p className="font-mono text-[11px] text-ink-soft">No lines.</p>}
          </div>
        ))}
        {records.length === 0 && <p className="font-mono text-xs text-ink-soft">No stock-ins yet.</p>}
      </div>
    </div>
  );
}
