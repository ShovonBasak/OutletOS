const MAP: Record<string, string> = {
  DRAFT: "stamp-draft",
  PENDING: "stamp-pending",
  APPROVED: "stamp-approved",
  REJECTED: "stamp-rejected",
  VARIANCE: "stamp-variance",
  SUBMITTED: "stamp-pending",
  LOCKED: "stamp-approved",
  ACTIVE: "stamp-approved",
  RECEIVED: "stamp-approved",
  INACTIVE: "stamp-draft",
  "IN PROGRESS": "stamp-pending",
};

export function Stamp({ status, flat }: { status: string; flat?: boolean }) {
  const cls = MAP[status.toUpperCase()] ?? "stamp-draft";
  return (
    <span className={`stamp ${cls} ${flat ? "rotate-0" : ""}`}>{status}</span>
  );
}
