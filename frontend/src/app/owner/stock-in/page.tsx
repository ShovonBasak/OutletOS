"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, apiDownload } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { today } from "@/lib/format";
import { Stamp } from "@/components/Stamp";
import AccountPicker from "@/components/AccountPicker";
import type { FinancialAccount, Ingredient, Paginated, StockInRecord, StockInItem } from "@/lib/types";

// ── helpers ─────────────────────────────────────────────────────────────────

function fullDate(iso: string): string {
  const d = iso.length === 10 ? new Date(`${iso}T12:00:00`) : new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function sourceLabel(r: StockInRecord): string {
  const hasSlip = r.items.some((i) => i.source === "SLIP_EXTRACTED");
  const hasManual = r.items.some((i) => i.source === "MANUAL");
  if (hasSlip && hasManual) return "Slip + manual";
  if (hasSlip) return "Slip";
  return "Manual";
}

function fmt(val: string | null | undefined, decimals = 2): string {
  if (val == null || val === "") return "—";
  const n = parseFloat(val);
  return isNaN(n) ? "—" : n.toFixed(decimals);
}

function fmtQty(val: string | null | undefined): string {
  if (val == null || val === "") return "—";
  const n = parseFloat(val);
  return isNaN(n) ? "—" : String(Number(n));
}

// ── item detail table (inside expanded invoice card) ─────────────────────────

function ItemTable({ items }: { items: StockInItem[] }) {
  const hasTax = items.some((i) => i.vat_rate || i.sd_rate);

  return (
    <div className="mt-2 overflow-x-auto border-t border-[#d8cdb0]">
      <table className="w-full min-w-[520px] border-collapse font-mono text-[11px]">
        <thead>
          <tr className="border-b border-[#d8cdb0] text-[10px] uppercase tracking-wide text-ink-soft">
            <th className="py-1.5 pr-3 text-left">Ingredient</th>
            <th className="py-1.5 pr-3 text-right">Qty</th>
            <th className="py-1.5 pr-3 text-right">Rate</th>
            {hasTax && (
              <>
                <th className="py-1.5 pr-3 text-right">SD%</th>
                <th className="py-1.5 pr-3 text-right">SD ৳</th>
                <th className="py-1.5 pr-3 text-right">VAT%</th>
                <th className="py-1.5 pr-3 text-right">VAT ৳</th>
              </>
            )}
            <th className="py-1.5 pr-3 text-right">Total</th>
            <th className="py-1.5 text-right">Unit (after tax)</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, i) => (
            <tr
              key={item.id ?? i}
              className="border-b border-dotted border-[#e8e0cc] last:border-0"
            >
              <td className="py-1.5 pr-3 font-medium text-ink">
                {item.ingredient_name ?? item.raw_extracted_text ?? "—"}
                {item.is_unrecognized && (
                  <span className="ml-1 text-chili">(unrecognized)</span>
                )}
              </td>
              <td className="py-1.5 pr-3 text-right">
                {fmtQty(item.confirmed_quantity)}
                {item.base_unit && (
                  <span className="ml-0.5 text-ink-soft">{item.base_unit}</span>
                )}
              </td>
              <td className="py-1.5 pr-3 text-right">
                {item.rate ? `৳${fmt(item.rate)}` : "—"}
              </td>
              {hasTax && (
                <>
                  <td className="py-1.5 pr-3 text-right text-ink-soft">
                    {item.sd_rate ? `${fmt(item.sd_rate)}%` : "—"}
                  </td>
                  <td className="py-1.5 pr-3 text-right text-ink-soft">
                    {item.sd_amount ? `৳${fmt(item.sd_amount)}` : "—"}
                  </td>
                  <td className="py-1.5 pr-3 text-right text-ink-soft">
                    {item.vat_rate ? `${fmt(item.vat_rate)}%` : "—"}
                  </td>
                  <td className="py-1.5 pr-3 text-right text-ink-soft">
                    {item.vat_amount ? `৳${fmt(item.vat_amount)}` : "—"}
                  </td>
                </>
              )}
              <td className="py-1.5 pr-3 text-right font-semibold">
                {item.line_total ? `৳${fmt(item.line_total)}` : "—"}
              </td>
              <td className="py-1.5 text-right text-ink-soft">
                {item.unit_price ? `৳${fmt(item.unit_price, 4)}` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── collapsible invoice card (history list) ──────────────────────────────────

function InvoiceRow({
  r,
  busy,
  accounts,
  onAct,
  onResume,
}: {
  r: StockInRecord;
  busy: boolean;
  accounts: FinancialAccount[];
  onAct: (id: number, action: "approve" | "reject" | "delete", accountId?: number | null) => void;
  onResume?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const primaryId = accounts.find((a) => a.is_primary_cash)?.id ?? accounts[0]?.id;
  const [approvalAccount, setApprovalAccount] = useState(
    r.paid_from_account ? String(r.paid_from_account) : (primaryId ? String(primaryId) : "")
  );
  const invoiceLabel = r.invoice_number
    ? r.invoice_number
    : `#SI-${String(r.id).padStart(4, "0")}`;

  const totalAfterTax = r.items.reduce((sum, item) => {
    const v = item.line_total ? parseFloat(item.line_total) : 0;
    return sum + (isNaN(v) ? 0 : v);
  }, 0);
  const totalLabel = totalAfterTax > 0 ? `৳${totalAfterTax.toFixed(2)}` : null;

  return (
    <div className="rounded border border-[#d8cdb0] bg-paper">
      <button
        className="w-full px-4 pt-3 pb-2.5 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="min-w-0">
            <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft mb-0.5">Invoice</p>
            <p className="font-display text-sm font-bold text-ink truncate">{invoiceLabel}</p>
          </div>
          <Stamp status={r.status} flat />
        </div>
        <div className="flex flex-wrap items-end gap-x-6 gap-y-1">
          <div>
            <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft">Date</p>
            <p className="font-mono text-[11px] text-ink">{fullDate(r.stock_in_date)}</p>
          </div>
          <div>
            <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft">Source</p>
            <p className="font-mono text-[11px] text-ink">{sourceLabel(r)}</p>
          </div>
          <div>
            <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft">Submitted by</p>
            <p className="font-mono text-[11px] text-ink">{r.submitted_by_name}</p>
          </div>
          {totalLabel && (
            <div>
              <p className="font-mono text-[9px] uppercase tracking-widest text-ink-soft">Total (after tax)</p>
              <p className="font-mono text-[12px] font-semibold text-ink">{totalLabel}</p>
            </div>
          )}
          <span className="ml-auto font-mono text-[10px] text-ink-soft">
            {open ? "▴ less" : "▾ details"}
          </span>
        </div>
      </button>

      {open && (
        <div className="px-3 pb-3">
          {r.items.length === 0 ? (
            <p className="py-2 font-mono text-[11px] text-ink-soft">No items on this record.</p>
          ) : (
            <ItemTable items={r.items} />
          )}

          {r.slip_image && (
            <div className="mt-3">
              <p className="mb-1.5 font-mono text-[9px] uppercase tracking-wide text-ink-soft">Delivery slip</p>
              <a href={r.slip_image} target="_blank" rel="noopener noreferrer">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={r.slip_image}
                  alt="Delivery slip"
                  className="max-h-64 w-full rounded border border-[#d8cdb0] object-contain bg-[#faf7ee] cursor-zoom-in"
                />
                <p className="mt-1 font-mono text-[10px] text-leaf-deep underline">Open full size ↗</p>
              </a>
            </div>
          )}

          {r.status === "PENDING" && (
            <div className="mt-3 flex flex-col gap-2">
              <div className="flex flex-col gap-1">
                <span className="font-mono text-[10px] uppercase text-ink-soft">Paid from account</span>
                <AccountPicker
                  accounts={accounts.filter((a) => a.is_active)}
                  value={approvalAccount}
                  onChange={setApprovalAccount}
                  showBalance
                  placeholder="— not specified —"
                />
              </div>
              <div className="flex gap-2">
                <button
                  className="rounded-sm bg-leaf px-3 py-1 font-mono text-[11px] uppercase text-white disabled:opacity-50"
                  disabled={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    onAct(r.id, "approve", approvalAccount ? Number(approvalAccount) : null);
                  }}
                >
                  Approve
                </button>
                <button
                  className="rounded-sm border border-chili px-3 py-1 font-mono text-[11px] uppercase text-chili-deep disabled:opacity-50"
                  disabled={busy}
                  onClick={(e) => { e.stopPropagation(); onAct(r.id, "reject"); }}
                >
                  Reject
                </button>
              </div>
            </div>
          )}
          {r.status === "DRAFT" && (
            <div className="mt-3 flex items-center gap-4">
              {onResume && (
                <button
                  className="font-mono text-[11px] text-leaf-deep underline"
                  onClick={(e) => { e.stopPropagation(); onResume(); }}
                >
                  Edit &amp; submit →
                </button>
              )}
              <button
                className="font-mono text-[10px] text-chili underline disabled:opacity-50"
                disabled={busy}
                onClick={(e) => { e.stopPropagation(); onAct(r.id, "delete"); }}
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

// ── draft line type ───────────────────────────────────────────────────────────

interface DraftLine {
  ingredient: number | null;
  ingredient_name?: string;
  raw_extracted_text: string;
  source: "SLIP_EXTRACTED" | "MANUAL";
  unit_captured: "PACK" | "PIECE";
  extracted_quantity: string | null;
  confirmed_quantity: string;
  pack_definition: number | null;
  rate: string;
  total_amount: string;
  sd_rate: string;
  sd_amount: string;
  vat_rate: string;
  vat_amount: string;
  line_total: string;
  unit_price: string;
}

function toEditLines(items: StockInItem[]): DraftLine[] {
  return items.map((it) => ({
    ingredient: it.ingredient,
    ingredient_name: it.ingredient_name,
    raw_extracted_text: it.raw_extracted_text ?? "",
    source: it.source,
    unit_captured: it.unit_captured,
    extracted_quantity: it.extracted_quantity ?? null,
    confirmed_quantity: String(it.confirmed_quantity),
    pack_definition: it.pack_definition,
    rate: it.rate ?? "",
    total_amount: it.total_amount ?? "",
    sd_rate: it.sd_rate ?? "",
    sd_amount: it.sd_amount ?? "",
    vat_rate: it.vat_rate ?? "",
    vat_amount: it.vat_amount ?? "",
    line_total: it.line_total ?? "",
    unit_price: it.unit_price ?? "",
  }));
}

// ── main page ─────────────────────────────────────────────────────────────────

export default function StockInApprovals() {
  const { user } = useAuth();
  const outlet = user?.outlet ?? 1;

  // list state
  const [records, setRecords] = useState<StockInRecord[]>([]);
  const [accounts, setAccounts] = useState<FinancialAccount[]>([]);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [actBusy, setActBusy] = useState<number | null>(null);

  // draft state
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [draft, setDraft] = useState<StockInRecord | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [draftBusy, setDraftBusy] = useState("");
  const [draftMsg, setDraftMsg] = useState("");
  const [invoiceNo, setInvoiceNo] = useState("");
  const [invoiceDate, setInvoiceDate] = useState("");
  const [xlsImgFile, setXlsImgFile] = useState<File | null>(null);
  const xlsRef = useRef<HTMLInputElement>(null);
  const xlsImgRef = useRef<HTMLInputElement>(null);

  // manual entry form fields
  const ingById = useMemo(() => {
    const m = new Map<number, Ingredient>();
    ingredients.forEach((i) => m.set(i.id, i));
    return m;
  }, [ingredients]);
  const [manualIng, setManualIng] = useState<number | "">("");
  const [manualQty, setManualQty] = useState("1");
  const [manualUnit, setManualUnit] = useState<"PACK" | "PIECE">("PIECE");
  const [manualRate, setManualRate] = useState("");

  // inline one-time ingredient creation (for unrecognized lines)
  const [createLineIdx, setCreateLineIdx] = useState<number | null>(null);
  const [createName, setCreateName] = useState("");
  const [createUnit, setCreateUnit] = useState("item");
  const [createBusy, setCreateBusy] = useState(false);

  async function refresh() {
    const qs = status ? `?status=${status}` : "";
    const [ing, recs, acc] = await Promise.all([
      api<Paginated<Ingredient>>("/ingredients/?active=true"),
      api<Paginated<StockInRecord>>(`/stock-in/${qs}`),
      api<Paginated<FinancialAccount>>("/financial-accounts/"),
    ]);
    setIngredients(ing.results);
    setRecords(recs.results);
    setAccounts(acc.results);
    if (!manualIng && ing.results.length) setManualIng(ing.results[0].id);
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  async function act(id: number, action: "approve" | "reject" | "delete", accountId?: number | null) {
    setActBusy(id);
    try {
      if (action === "delete") {
        await api(`/stock-in/${id}/`, { method: "DELETE" });
      } else if (action === "approve") {
        await api(`/stock-in/${id}/approve/`, {
          method: "POST",
          body: JSON.stringify({ paid_from_account: accountId ?? null }),
        });
      } else {
        await api(`/stock-in/${id}/${action}/`, { method: "POST" });
      }
      await refresh();
    } finally {
      setActBusy(null);
    }
  }

  function resumeDraft(r: StockInRecord) {
    setDraft(r);
    setLines(toEditLines(r.items));
    setInvoiceNo(r.invoice_number ?? "");
    setInvoiceDate(r.stock_in_date ?? "");
    setDraftMsg("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function startDraft() {
    setDraftBusy("new");
    setDraftMsg("");
    try {
      const rec = await api<StockInRecord>("/stock-in/", {
        method: "POST",
        body: JSON.stringify({ outlet, stock_in_date: invoiceDate || today(), items: [] }),
      });
      setDraft(rec);
      setLines([]);
    } finally {
      setDraftBusy("");
    }
  }

  async function downloadTemplate() {
    try {
      await apiDownload("/stock-in/sample-excel/", "stock_in_template.xlsx");
    } catch {
      setDraftMsg("Could not download template.");
    }
  }

  async function onXlsChosen(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !draft) return;
    setDraftBusy("import");
    setDraftMsg("");
    try {
      const form = new FormData();
      form.append("excel_file", file);
      if (invoiceNo.trim())   form.append("invoice_number", invoiceNo.trim());
      if (invoiceDate.trim()) form.append("stock_in_date",  invoiceDate.trim());
      if (xlsImgFile)         form.append("slip_image",     xlsImgFile);

      const result = await api<StockInRecord & { imported_count: number; unresolved_names: string[] }>(
        `/stock-in/${draft.id}/import-excel/`,
        { method: "POST", body: form }
      );
      setDraft(result);
      setLines(toEditLines(result.items));
      const unres = result.unresolved_names.length;
      setDraftMsg(
        result.imported_count > 0
          ? `Imported ${result.imported_count} line(s)${unres ? ` · ${unres} unrecognized` : ""}.`
          : "No lines found in the file."
      );
      setXlsImgFile(null);
    } catch {
      setDraftMsg("Import failed — check the file uses the template format.");
    } finally {
      setDraftBusy("");
      if (xlsRef.current)    xlsRef.current.value = "";
      if (xlsImgRef.current) xlsImgRef.current.value = "";
    }
  }

  function addManualItem() {
    if (!manualIng) return;
    const ing = ingById.get(Number(manualIng));
    const qty = parseFloat(manualQty) || 1;
    const rate = manualRate.trim();
    const rateNum = parseFloat(rate) || 0;
    const total = (rateNum * qty).toFixed(2);
    setLines((ls) => [
      ...ls,
      {
        ingredient: Number(manualIng),
        ingredient_name: ing?.name,
        raw_extracted_text: "",
        source: "MANUAL",
        unit_captured: manualUnit,
        extracted_quantity: null,
        confirmed_quantity: String(qty),
        pack_definition: ing?.active_pack?.id ?? null,
        rate: rate,
        total_amount: total,
        sd_rate: "0",
        sd_amount: "0",
        vat_rate: "0",
        vat_amount: "0",
        line_total: total,
        unit_price: rate,
      },
    ]);
    setManualRate("");
    setManualQty("1");
  }

  function removeLine(i: number) {
    setLines((ls) => ls.filter((_, idx) => idx !== i));
    setCreateLineIdx(null);
    setCreateName("");
    setCreateUnit("item");
  }

  async function createOneTime(lineIdx: number) {
    if (!createName.trim()) return;
    setCreateBusy(true);
    try {
      const ing = await api<Ingredient>("/ingredients/", {
        method: "POST",
        body: JSON.stringify({
          name: createName.trim(),
          base_unit: createUnit.trim() || "item",
          tracking_mode: "ONE_TIME",
          is_active: true,
        }),
      });
      setIngredients((prev) => [...prev, ing]);
      setLines((ls) =>
        ls.map((x, idx) =>
          idx === lineIdx ? { ...x, ingredient: ing.id, ingredient_name: ing.name } : x
        )
      );
      setCreateLineIdx(null);
      setCreateName("");
      setCreateUnit("item");
    } catch {
      // leave form open so the user can retry
    } finally {
      setCreateBusy(false);
    }
  }

  async function persist(): Promise<StockInRecord | null> {
    if (!draft) return null;
    const items = lines
      .filter((l) => Number(l.confirmed_quantity) > 0)
      .map((l) => ({
        ingredient: l.ingredient,
        raw_extracted_text: l.raw_extracted_text,
        source: l.source,
        unit_captured: l.unit_captured,
        extracted_quantity: l.extracted_quantity,
        confirmed_quantity: l.confirmed_quantity,
        pack_definition: l.pack_definition,
        rate: l.rate || null,
        total_amount: l.total_amount || null,
        sd_rate: l.sd_rate || null,
        sd_amount: l.sd_amount || null,
        vat_rate: l.vat_rate || null,
        vat_amount: l.vat_amount || null,
        line_total: l.line_total || null,
        unit_price: l.unit_price || null,
      }));
    const rec = await api<StockInRecord>(`/stock-in/${draft.id}/`, {
      method: "PUT",
      body: JSON.stringify({
        outlet,
        stock_in_date: invoiceDate || draft.stock_in_date,
        invoice_number: invoiceNo || draft.invoice_number,
        items,
      }),
    });
    setDraft(rec);
    setLines(toEditLines(rec.items));
    return rec;
  }

  async function submit() {
    if (!draft) return;
    setDraftBusy("submit");
    setDraftMsg("");
    try {
      const rec = await persist();
      if (!rec || rec.unresolved_count > 0) {
        setDraftMsg(`Resolve ${rec?.unresolved_count ?? 0} unrecognized line(s) before submitting.`);
        return;
      }
      await api(`/stock-in/${draft.id}/submit/`, { method: "POST" });
      setDraft(null);
      setLines([]);
      setInvoiceNo("");
      setInvoiceDate("");
      setDraftMsg("Submitted ✓");
      await refresh();
    } catch {
      setDraftMsg("Submit failed.");
    } finally {
      setDraftBusy("");
    }
  }

  const rows = useMemo(
    () =>
      records.filter((r) =>
        search
          ? r.invoice_number?.toLowerCase().includes(search.toLowerCase()) ||
            String(r.id).includes(search.replace(/\D/g, ""))
          : true
      ),
    [records, search]
  );

  // Grand total of current draft lines
  const draftTotal = lines.reduce((s, l) => {
    const v = parseFloat(l.line_total);
    return s + (isNaN(v) ? 0 : v);
  }, 0);

  return (
    <div className="flex flex-col gap-4">
      {/* Always-mounted hidden file inputs */}
      <input ref={xlsImgRef} type="file" accept="image/*" className="hidden"
        onChange={(e) => setXlsImgFile(e.target.files?.[0] ?? null)} />
      <input ref={xlsRef} type="file" accept=".xlsx,.xls" className="hidden"
        onChange={onXlsChosen} />

      {/* ── Active draft ─────────────────────────────────────────────────── */}
      {!draft ? (
        <button
          className="btn btn-primary self-start"
          disabled={draftBusy === "new"}
          onClick={startDraft}
        >
          {draftBusy === "new" ? "…" : "+ New Stock In"}
        </button>
      ) : (
        <div className="ticket flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <p className="font-mono text-[11px] uppercase tracking-wide text-ink-soft">
              New stock-in · draft #{draft.id}
            </p>
            <button
              className="font-mono text-[10px] text-ink-soft underline"
              onClick={() => { setDraft(null); setLines([]); setDraftMsg(""); }}
            >
              close
            </button>
          </div>

          {/* Invoice meta */}
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="font-mono text-[10px] uppercase text-ink-soft">Invoice no.</label>
              <input
                type="text"
                className="field-input"
                placeholder="e.g. INV-2024-001"
                value={invoiceNo}
                onChange={(e) => setInvoiceNo(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="font-mono text-[10px] uppercase text-ink-soft">Invoice date</label>
              <input
                type="date"
                className="field-input"
                value={invoiceDate}
                onChange={(e) => setInvoiceDate(e.target.value)}
              />
            </div>
          </div>

          {/* Excel import */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="field-label">Import from Excel</span>
              <button
                type="button"
                className="font-mono text-[10px] text-leaf-deep underline"
                onClick={downloadTemplate}
              >
                Download template
              </button>
            </div>
            {/* Optional invoice image for the Excel import */}
            <div className="flex flex-col gap-1">
              <label className="font-mono text-[10px] uppercase text-ink-soft">
                Invoice image <span className="normal-case text-ink-soft/60">(optional)</span>
              </label>
              <button
                type="button"
                className="btn btn-ghost !py-1.5 text-left font-mono text-[11px]"
                onClick={() => xlsImgRef.current?.click()}
              >
                {xlsImgFile ? `📎 ${xlsImgFile.name}` : "+ Attach invoice image"}
              </button>
              {xlsImgFile && (
                <button
                  type="button"
                  className="self-start font-mono text-[10px] text-chili underline"
                  onClick={() => { setXlsImgFile(null); if (xlsImgRef.current) xlsImgRef.current.value = ""; }}
                >
                  Remove
                </button>
              )}
            </div>
            <button
              className="btn btn-ghost"
              disabled={draftBusy === "import"}
              onClick={() => xlsRef.current?.click()}
            >
              {draftBusy === "import" ? "Importing…" : "Select Excel file"}
            </button>
          </div>

          {/* Divider */}
          <div className="relative flex items-center">
            <div className="flex-1 border-t border-dashed border-[#d8cdb0]" />
            <span className="mx-2 font-mono text-[10px] uppercase text-ink-soft">or add manually</span>
            <div className="flex-1 border-t border-dashed border-[#d8cdb0]" />
          </div>

          {/* Manual entry row */}
          <div className="flex flex-col gap-2">
            <span className="field-label">Add item outside invoice</span>
            <div className="flex flex-wrap gap-2 items-end">
              <div className="flex flex-col gap-1 flex-1 min-w-[140px]">
                <label className="font-mono text-[10px] uppercase text-ink-soft">Ingredient</label>
                <select
                  className="field-input"
                  value={manualIng}
                  onChange={(e) => setManualIng(Number(e.target.value))}
                >
                  {ingredients.map((ing) => (
                    <option key={ing.id} value={ing.id}>{ing.name}</option>
                  ))}
                </select>
              </div>
              <div className="flex flex-col gap-1 w-20">
                <label className="font-mono text-[10px] uppercase text-ink-soft">Qty</label>
                <input
                  type="text"
                  inputMode="decimal"
                  className="field-input text-center"
                  value={manualQty}
                  onChange={(e) => setManualQty(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1 w-24">
                <label className="font-mono text-[10px] uppercase text-ink-soft">Unit</label>
                <select
                  className="field-input"
                  value={manualUnit}
                  onChange={(e) => setManualUnit(e.target.value as "PACK" | "PIECE")}
                >
                  <option value="PACK">pack(s)</option>
                  <option value="PIECE">
                    {manualIng ? (ingById.get(Number(manualIng))?.base_unit ?? "piece") : "piece"}
                  </option>
                </select>
              </div>
              <div className="flex flex-col gap-1 w-28">
                <label className="font-mono text-[10px] uppercase text-ink-soft">Price (৳)</label>
                <input
                  type="text"
                  inputMode="decimal"
                  className="field-input"
                  placeholder="0.00"
                  value={manualRate}
                  onChange={(e) => setManualRate(e.target.value)}
                />
              </div>
              <button
                className="btn btn-ghost !px-3 !py-1.5 font-mono text-[11px]"
                onClick={addManualItem}
                disabled={!manualIng}
              >
                + Add
              </button>
            </div>
            <p className="font-mono text-[10px] text-ink-soft/70">
              VAT &amp; SD auto-filled as 0 · total = price entered
            </p>
          </div>

          {/* Draft lines */}
          {lines.length > 0 && (
            <div className="flex flex-col gap-0 border border-[#d8cdb0] rounded">
              {lines.map((l, i) => {
                const isUnresolved = l.ingredient === null;
                const qty = parseFloat(l.confirmed_quantity) || 0;
                const rateNum = parseFloat(l.rate) || 0;
                const total = parseFloat(l.line_total) || 0;
                return (
                  <div
                    key={i}
                    className={`flex items-start gap-3 px-3 py-2 border-b border-dotted last:border-0 ${
                      isUnresolved ? "bg-[#fff8f6] border-[#f0d0c8]" : "border-[#e8e0cc]"
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      {isUnresolved ? (
                        <div className="flex flex-col gap-1.5">
                          <p className="font-mono text-[10px] text-chili uppercase tracking-wide font-semibold">
                            Unrecognized — assign to ingredient:
                          </p>
                          {l.raw_extracted_text && (
                            <p className="font-mono text-[10px] text-ink-soft truncate">
                              &ldquo;{l.raw_extracted_text}&rdquo;
                            </p>
                          )}
                          <select
                            className="field-input text-[11px]"
                            value={l.ingredient ?? ""}
                            onChange={(e) => {
                              const id = Number(e.target.value);
                              const ing = ingById.get(id);
                              setLines((ls) =>
                                ls.map((x, idx) =>
                                  idx === i
                                    ? { ...x, ingredient: id, ingredient_name: ing?.name }
                                    : x
                                )
                              );
                              setCreateLineIdx(null);
                            }}
                          >
                            <option value="">— Select ingredient —</option>
                            {ingredients.map((ing) => (
                              <option key={ing.id} value={ing.id}>{ing.name}</option>
                            ))}
                          </select>

                          {/* Inline one-time create */}
                          {createLineIdx === i ? (
                            <div className="flex flex-col gap-1.5 pt-1.5 border-t border-dashed border-[#f0d0c8]">
                              <p className="font-mono text-[10px] uppercase tracking-wide text-chili">
                                New one-time ingredient
                              </p>
                              <div className="flex gap-2 flex-wrap">
                                <input
                                  type="text"
                                  className="field-input flex-1 min-w-[120px] text-[11px]"
                                  placeholder="Name"
                                  value={createName}
                                  onChange={(e) => setCreateName(e.target.value)}
                                  onKeyDown={(e) => e.key === "Enter" && createOneTime(i)}
                                  autoFocus
                                />
                                <input
                                  type="text"
                                  className="field-input w-20 text-[11px]"
                                  placeholder="Unit"
                                  value={createUnit}
                                  onChange={(e) => setCreateUnit(e.target.value)}
                                />
                                <button
                                  className="btn btn-ghost !py-1 !px-2 font-mono text-[11px] shrink-0"
                                  disabled={createBusy || !createName.trim()}
                                  onClick={() => createOneTime(i)}
                                >
                                  {createBusy ? "…" : "Create"}
                                </button>
                                <button
                                  className="font-mono text-[10px] text-ink-soft underline shrink-0"
                                  onClick={() => { setCreateLineIdx(null); setCreateName(""); setCreateUnit("item"); }}
                                >
                                  cancel
                                </button>
                              </div>
                              <p className="font-mono text-[10px] text-ink-soft/70">
                                Saved as one-time purchase — not tracked in stock
                              </p>
                            </div>
                          ) : (
                            <button
                              className="self-start font-mono text-[10px] text-ink-soft underline"
                              onClick={() => {
                                setCreateLineIdx(i);
                                setCreateName(
                                  l.raw_extracted_text
                                    ?.replace(/^\d[\d.,]*\s*/, "")
                                    .trim() || ""
                                );
                                setCreateUnit("item");
                              }}
                            >
                              or create as one-time purchase ▸
                            </button>
                          )}

                          <p className="font-mono text-[10px] text-ink-soft">
                            {qty} {l.unit_captured === "PACK" ? "pack(s)" : "pcs"}
                            {rateNum > 0 && <span className="ml-2">@ ৳{rateNum.toFixed(2)}</span>}
                          </p>
                        </div>
                      ) : (
                        <>
                          <p className="font-mono text-[12px] font-medium text-ink truncate">
                            {l.ingredient_name ?? l.raw_extracted_text ?? "—"}
                            {l.source === "SLIP_EXTRACTED" && (
                              <span className="ml-1 text-[9px] uppercase text-leaf-deep">slip</span>
                            )}
                          </p>
                          <p className="font-mono text-[10px] text-ink-soft">
                            {qty} {l.unit_captured === "PACK" ? "pack(s)" : (ingById.get(l.ingredient!)?.base_unit ?? "pcs")}
                            {rateNum > 0 && <span className="ml-2">@ ৳{rateNum.toFixed(2)}</span>}
                          </p>
                        </>
                      )}
                    </div>
                    <div className="text-right shrink-0 pt-0.5">
                      {total > 0 ? (
                        <p className="font-mono text-[12px] font-semibold text-ink">৳{total.toFixed(2)}</p>
                      ) : (
                        <p className="font-mono text-[11px] text-ink-soft">—</p>
                      )}
                    </div>
                    <button
                      className="shrink-0 font-mono text-[10px] text-chili underline pt-0.5"
                      onClick={() => removeLine(i)}
                    >
                      Remove
                    </button>
                  </div>
                );
              })}
              {draftTotal > 0 && (
                <div className="flex justify-end px-3 py-2 border-t border-[#d8cdb0] bg-[#faf7ee]">
                  <p className="font-mono text-[11px] text-ink-soft uppercase tracking-wide mr-3">Total</p>
                  <p className="font-mono text-[13px] font-bold text-ink">৳{draftTotal.toFixed(2)}</p>
                </div>
              )}
            </div>
          )}

          {draftMsg && <p className="font-mono text-[11px] text-ink-soft">{draftMsg}</p>}

          <button
            className="btn btn-primary"
            disabled={draftBusy === "submit" || lines.length === 0}
            onClick={submit}
          >
            {draftBusy === "submit" ? "Submitting…" : "Submit for approval"}
          </button>
        </div>
      )}

      {draftMsg && !draft && (
        <p className="font-mono text-[11px] text-ink-soft">{draftMsg}</p>
      )}

      {/* ── Filter + history list ─────────────────────────────────────────── */}
      <div className="filterbar">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All statuses</option>
          <option value="DRAFT">Draft</option>
          <option value="PENDING">Pending</option>
          <option value="APPROVED">Approved</option>
          <option value="REJECTED">Rejected</option>
        </select>
        <input
          placeholder="Search invoice / record #"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-2">
        {rows.map((r) => (
          <InvoiceRow
            key={r.id}
            r={r}
            busy={actBusy === r.id}
            accounts={accounts}
            onAct={act}
            onResume={r.status === "DRAFT" ? () => resumeDraft(r) : undefined}
          />
        ))}
        {rows.length === 0 && (
          <p className="font-mono text-sm text-ink-soft">No records.</p>
        )}
      </div>
    </div>
  );
}
