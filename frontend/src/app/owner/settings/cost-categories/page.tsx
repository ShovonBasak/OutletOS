"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { CostCategory, Paginated } from "@/lib/types";

export default function CostCategoriesPage() {
  const [categories, setCategories] = useState<CostCategory[]>([]);

  useEffect(() => {
    api<Paginated<CostCategory>>("/cost-categories/").then((d) => setCategories(d.results));
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-ink-soft">
        Cost categories group expenses in the P&amp;L report. Fixed costs repeat every period;
        variable costs scale with volume; adhoc costs are one-offs.
      </p>
      <div className="overflow-x-auto">
        <table className="datatable min-w-[360px]">
          <thead>
            <tr>
              <th>Category</th>
              <th>Type</th>
            </tr>
          </thead>
          <tbody>
            {categories.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td className="capitalize">{c.cost_type.toLowerCase()}</td>
              </tr>
            ))}
            {categories.length === 0 && (
              <tr>
                <td colSpan={2} className="text-ink-soft">
                  No categories.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
