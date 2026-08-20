"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Stamp } from "@/components/Stamp";
import type { Outlet, Paginated, User } from "@/lib/types";

export default function TeamPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [outlets, setOutlets] = useState<Outlet[]>([]);

  useEffect(() => {
    api<Paginated<User>>("/users/").then((d) => setUsers(d.results));
    api<Paginated<Outlet>>("/outlets/").then((d) => setOutlets(d.results));
  }, []);

  const outletName = (id: number | null) => outlets.find((o) => o.id === id)?.name ?? "—";

  return (
    <div className="flex flex-col gap-5">
      <h2 className="sec">Staff</h2>
      <div className="overflow-x-auto">
        <table className="datatable min-w-[520px]">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Outlet</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td className="capitalize">{u.role.toLowerCase()}</td>
                <td>{u.role === "OWNER" || u.role === "ADMIN" ? "All" : outletName(u.outlet)}</td>
                <td>
                  <Stamp status={u.is_active ? "Active" : "Inactive"} flat />
                </td>
              </tr>
            ))}
            {users.length === 0 && (
              <tr>
                <td colSpan={4} className="text-ink-soft">
                  No users.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <h2 className="sec mt-2">Outlets</h2>
      <div className="overflow-x-auto">
        <table className="datatable min-w-[520px]">
          <thead>
            <tr>
              <th>Name</th>
              <th>Address</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {outlets.map((o) => (
              <tr key={o.id}>
                <td>{o.name}</td>
                <td>{o.address}</td>
                <td>
                  <Stamp status={o.is_active ? "Active" : "Inactive"} flat />
                </td>
              </tr>
            ))}
            {outlets.length === 0 && (
              <tr>
                <td colSpan={3} className="text-ink-soft">
                  No outlets.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <Link href="/owner/team/add-outlet" className="btn btn-ghost w-40">
        + Add outlet
      </Link>
    </div>
  );
}
