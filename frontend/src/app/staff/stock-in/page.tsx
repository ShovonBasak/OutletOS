"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useOperatingDay } from "@/lib/staffDay";
import { shortDate, today } from "@/lib/format";
import { Stamp } from "@/components/Stamp";
import AccountPicker from "@/components/AccountPicker";
import IngredientPicker from "@/components/IngredientPicker";
import type { FinancialAccountName, Ingredient, Paginated, StockInItem, StockInRecord } from "@/lib/types";

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
  // Price fields — preserved from Excel/OCR import, absent for pure manual lines
  rate?: string | null;
  total_amount?: string | null;
  sd_rate?: string | null;
  sd_amount?: string | null;
  vat_rate?: string | null;
  vat_amount?: string | null;
  line_total?: string | null;
  unit_price?: string | null;
}

function StockInCard({
  record,
  onResume,
  onDelete,
}: {
  record: StockInRecord;
  onResume: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const label = record.invoice_number
    ? record.invoice_number
    : `#SI-${String(record.id).padStart(4, "0")}`;
  const itemCount = record.items.length;

  return (
    <div className="rounded border border-[#d8cdb0] bg-paper">
      <button
        className="w-full px-3 pt-3 pb-2.5 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        {/* Row 1: invoice label + status */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="min-w-0">
            <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft mb-0.5">Invoice</p>
            <p className="font-display text-sm font-bold text-ink truncate">{label}</p>
          </div>
          <Stamp status={record.status} flat />
        </div>
        {/* Row 2: meta fields + chevron */}
        <div className="flex items-end gap-5">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft">Date</p>
            <p className="font-mono text-[11px] text-ink">{shortDate(record.stock_in_date)}</p>
          </div>
          <div>
            <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft">Items</p>
            <p className="font-mono text-[11px] text-ink">
              {itemCount} {itemCount === 1 ? "ingredient" : "ingredients"}
            </p>
          </div>
          <span className="ml-auto font-mono text-[10px] text-ink-soft">
            {open ? "▴ less" : "▾ details"}
          </span>
        </div>
      </button>

      {open && (
        <div className="border-t border-[#d8cdb0] px-3 pb-3 pt-2">
          {record.items.length === 0 ? (
            <p className="font-mono text-[11px] text-ink-soft">No lines.</p>
          ) : (
            <div className="flex flex-col gap-0">
              {record.items.map((it) => (
                <div
                  key={it.id}
                  className="flex items-baseline justify-between border-b border-dotted border-[#e8e0cc] py-1.5 last:border-0"
                >
                  <span className="font-mono text-[11px] text-ink">
                    {it.ingredient_name ?? `"${it.raw_extracted_text}"`}
                    {it.source === "SLIP_EXTRACTED" && (
                      <span className="ml-1 text-[9px] uppercase text-leaf-deep">slip</span>
                    )}
                  </span>
                  <span className="ml-3 shrink-0 font-mono text-[11px] text-ink-soft">
                    {Number(it.confirmed_quantity)}{" "}
                    {it.unit_captured === "PACK" ? "pack(s)" : (it.base_unit ?? "")}
                    {it.base_unit_quantity && it.unit_captured === "PACK" && (
                      <span className="ml-1 text-[10px]">= {it.base_unit_quantity} {it.base_unit}</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
          {record.status === "DRAFT" && (
            <div className="mt-2 flex items-center gap-4">
              <button
                className="font-mono text-[11px] text-leaf-deep underline"
                onClick={onResume}
              >
                Resume editing →
              </button>
              <button
                className="font-mono text-[10px] text-chili underline"
                onClick={(e) => { e.stopPropagation(); onDelete(); }}
              >
                Delete draft
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function StockInPage() {
  const { user } = useAuth();
  const { day, workDate } = useOperatingDay();
  const outlet = user?.outlet ?? 1;
  const opDate = workDate || today();
  const fileRef    = useRef<HTMLInputElement>(null);
  const aliasedRef = useRef<Set<string>>(new Set());

  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [accounts, setAccounts] = useState<FinancialAccountName[]>([]);
  const [records, setRecords] = useState<StockInRecord[]>([]);
  const [draft, setDraft] = useState<StockInRecord | null>(null);
  const [lines, setLines] = useState<EditLine[]>([]);
  const [accountId, setAccountId] = useState("");
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
      rate: it.rate ?? null,
      total_amount: it.total_amount ?? null,
      sd_rate: it.sd_rate ?? null,
      sd_amount: it.sd_amount ?? null,
      vat_rate: it.vat_rate ?? null,
      vat_amount: it.vat_amount ?? null,
      line_total: it.line_total ?? null,
      unit_price: it.unit_price ?? null,
    }));
  }

  async function refresh() {
    const [ing, r, acc] = await Promise.all([
      api<Paginated<Ingredient>>("/ingredients/?active=true"),
      api<Paginated<StockInRecord>>(`/stock-in/?outlet=${outlet}`),
      api<Paginated<FinancialAccountName>>("/financial-accounts/"),
    ]);
    setIngredients(ing.results);
    setRecords(r.results);
    const activeAccounts = acc.results.filter((a) => a.is_active);
    setAccounts(activeAccounts);
    if (!accountId && activeAccounts[0]) setAccountId(String(activeAccounts[0].id));
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
        body: JSON.stringify({ outlet, stock_in_date: opDate, items: [] }),
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
      setMsg('Slip attached. Tap "Auto-read from slip".');
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
        rate: l.rate ?? null,
        total_amount: l.total_amount ?? null,
        sd_rate: l.sd_rate ?? null,
        sd_amount: l.sd_amount ?? null,
        vat_rate: l.vat_rate ?? null,
        vat_amount: l.vat_amount ?? null,
        line_total: l.line_total ?? null,
        unit_price: l.unit_price ?? null,
      }));
    const rec = await api<StockInRecord>(`/stock-in/${draft.id}/`, {
      method: "PUT",
      body: JSON.stringify({
        outlet,
        stock_in_date: draft.stock_in_date,
        paid_from_account: accountId ? Number(accountId) : null,
        items,
      }),
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

  if (day?.status === "CLOSED") {
    return (
      <div className="flex flex-col gap-3 pt-4">
        <h1 className="font-display text-xl font-bold">Stock In</h1>
        <div className="rounded border border-[#d8cdb0] bg-[#fffdf7] px-4 py-3 font-mono text-xs text-ink-soft">
          🔒 Today&apos;s day is closed. Stock In is not available until the next day starts.
        </div>
      </div>
    );
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

          {/* Payment account */}
          <div className="flex flex-col gap-1">
            <span className="field-label">Paid from account</span>
            <AccountPicker
              accounts={accounts}
              value={accountId}
              onChange={setAccountId}
              placeholder="— not specified —"
            />
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
                      slip: "{l.raw_extracted_text}"
                    </p>
                  )}
                  {unrecognized ? (
                    <div className="mb-1.5">
                      <span className="font-mono text-[10px] uppercase text-chili">Unrecognized — match it</span>
                      <IngredientPicker
                        ingredients={ingredients}
                        value={null}
                        onChange={(id) => setLineIngredient(i, id)}
                        placeholder="Choose ingredient…"
                        className="mt-1"
                      />
                    </div>
                  ) : (
                    <IngredientPicker
                      ingredients={ingredients}
                      value={l.ingredient}
                      onChange={(id) => setLineIngredient(i, id)}
                    />
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
                    <button className="font-mono text-[10px] text-chili underline" onClick={() => removeLine(i)}>
                      Remove
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

      <div className="flex flex-col gap-2">
        {records.map((r) => (
          <StockInCard
            key={r.id}
            record={r}
            onResume={() => { setDraft(r); setLines(toEditLines(r.items)); }}
            onDelete={async () => {
              await api(`/stock-in/${r.id}/`, { method: "DELETE" });
              refresh();
            }}
          />
        ))}
        {records.length === 0 && <p className="font-mono text-xs text-ink-soft">No stock-ins yet.</p>}
      </div>
    </div>
  );
}
