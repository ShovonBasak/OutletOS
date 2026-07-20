"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Outlet, Paginated } from "@/lib/types";

export default function StaffProfile() {
  const { user, logout } = useAuth();
  const [outletName, setOutletName] = useState("");

  useEffect(() => {
    api<Paginated<Outlet>>("/outlets/").then((d) => {
      const o = d.results.find((x) => x.id === user?.outlet) ?? d.results[0];
      if (o) setOutletName(o.name);
    });
  }, [user?.outlet]);

  return (
    <div className="flex flex-col gap-4">
      <Link href="/staff" className="self-start font-mono text-[11px] text-ink">
        ‹ Back
      </Link>
      <div>
        <h1 className="font-display text-xl font-bold">Profile</h1>
        <p className="text-xs text-ink-soft">{outletName ? `${outletName} outlet · ` : ""}Staff</p>
      </div>

      <div className="flex flex-col gap-2">
        <div className="listrow">
          <span className="title">Name</span>
          <span className="meta">{user?.name}</span>
        </div>
        <div className="listrow">
          <span className="title">Phone</span>
          <span className="meta">{user?.phone}</span>
        </div>
      </div>

      <button className="btn btn-ghost" onClick={logout}>
        Log out
      </button>
    </div>
  );
}
