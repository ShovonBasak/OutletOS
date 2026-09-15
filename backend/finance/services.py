"""Centralized posting/voiding for AccountTransaction — the only sanctioned way
to create or remove one. Every caller (expenses, other income, stock-in
approval, daily closing, transfers, capital transactions, balance checks,
manual entries) routes through this module instead of touching
AccountTransaction.objects.create()/.delete() directly.

Why this exists: every AccountTransaction now carries a balance_before/
balance_after snapshot (finance/models.py), computed in LEDGER ORDER —
(date, id) ascending — which is distinct from the display order (newest
first). `date` is freely backdatable (this business backdates routinely), so
`id` — assigned once at insertion, never changes — is what disambiguates
same-day rows for balance math: a newly posted same-day transaction always
lands after existing same-day rows.

Maintaining that snapshot correctly requires two things every raw .create()
call was missing: (1) locking the account row so concurrent postings can't
race on "what's the balance right now", and (2) cascading the shift to every
LATER transaction when a transaction lands earlier in ledger order than the
most recent one (i.e. a backdated posting) — done as one bulk UPDATE via
F(), not a per-row loop.
"""
from decimal import Decimal

from django.db import transaction as db_transaction
from django.db.models import F, Q, Sum

from .models import AccountTransaction, FinancialAccount


def _post_locked(account, *, transaction_type, amount, date, entered_by,
                  source_type="", source_id=None, note=""):
    """Core posting logic. Caller MUST already hold `account`'s row lock
    (via select_for_update, inside an atomic block) — this function does not
    lock anything itself, so it can be reused by callers that need to hold
    more than one account's lock at once (see post_transfer_pair)."""
    prior_sum = account.transactions.filter(
        Q(date__lt=date) | Q(date=date)
    ).aggregate(total=Sum("amount"))["total"] or Decimal("0")
    balance_before = account.opening_balance + prior_sum
    balance_after = balance_before + amount

    txn = AccountTransaction.objects.create(
        account=account, transaction_type=transaction_type, amount=amount, date=date,
        source_type=source_type, source_id=source_id, entered_by=entered_by, note=note,
        balance_before=balance_before, balance_after=balance_after,
    )
    _shift_later(account, after_date=date, after_id=txn.id, delta=amount)
    return txn


def _shift_later(account, after_date, after_id, delta):
    """Bulk-shift every transaction strictly after (after_date, after_id) in
    ledger order — one UPDATE regardless of how many later rows exist."""
    if not delta:
        return
    AccountTransaction.objects.filter(account=account).filter(
        Q(date__gt=after_date) | Q(date=after_date, id__gt=after_id)
    ).update(
        balance_before=F("balance_before") + delta,
        balance_after=F("balance_after") + delta,
    )


def post_transaction(*, account, transaction_type, amount, date, entered_by,
                      source_type="", source_id=None, note="") -> AccountTransaction:
    """Post one transaction on a single account. Locks `account` for the
    duration. This is the normal case — expenses, other income, stock-in
    payment deductions, manual entries, one leg of a daily-closing settlement."""
    with db_transaction.atomic():
        acct = FinancialAccount.objects.select_for_update().get(pk=account.pk)
        return _post_locked(
            acct, transaction_type=transaction_type, amount=amount, date=date,
            entered_by=entered_by, source_type=source_type, source_id=source_id, note=note,
        )


def void_transaction(txn_id) -> None:
    """Delete a transaction and reverse-cascade the shift to later rows on its
    account. The only sanctioned way to remove an AccountTransaction."""
    with db_transaction.atomic():
        txn = AccountTransaction.objects.select_related("account").get(pk=txn_id)
        acct = FinancialAccount.objects.select_for_update().get(pk=txn.account_id)
        _shift_later(acct, after_date=txn.date, after_id=txn.id, delta=-txn.amount)
        txn.delete()


def post_transfer_pair(*, from_account, to_account, amount, date, entered_by,
                        source_type, source_id, note_out="", note_in=""):
    """Post both legs of a transfer as one true all-or-nothing operation.

    Locks BOTH accounts up front, always in ascending-id order regardless of
    which is 'from'/'to' — every caller acquiring locks in the same global
    order is what prevents deadlock against a concurrent reverse transfer
    (B→A racing this A→B). Both legs post inside one transaction: either both
    commit or neither does.
    """
    first, second = sorted([from_account, to_account], key=lambda a: a.pk)
    with db_transaction.atomic():
        locked_first = FinancialAccount.objects.select_for_update().get(pk=first.pk)
        locked_second = FinancialAccount.objects.select_for_update().get(pk=second.pk)
        locked_from = locked_first if locked_first.pk == from_account.pk else locked_second
        locked_to = locked_second if locked_second.pk == to_account.pk else locked_first

        leg_out = _post_locked(
            locked_from, transaction_type="TRANSFER_OUT", amount=-amount, date=date,
            entered_by=entered_by, source_type=source_type, source_id=source_id, note=note_out,
        )
        leg_in = _post_locked(
            locked_to, transaction_type="TRANSFER_IN", amount=amount, date=date,
            entered_by=entered_by, source_type=source_type, source_id=source_id, note=note_in,
        )
    return leg_out, leg_in


def rebuild_account_balances(account_id) -> dict:
    """Full sequential replay of one account's history — opening_balance
    forward through every transaction in ledger order (date, id) — resetting
    balance_before/balance_after to match. Idempotent: only rows that
    actually differ get written, so a second run changes nothing.

    Used by: the 0006 data migration (reimplemented there, self-contained —
    not imported, since migrations must survive this module changing later),
    the owner's "Recalculate balances" action, the rebuild_account_balances
    management command, and automatically whenever opening_balance /
    opening_balance_date changes (FinancialAccountViewSet.perform_update).
    """
    with db_transaction.atomic():
        acct = FinancialAccount.objects.select_for_update().get(pk=account_id)
        running = acct.opening_balance
        to_update = []
        checked = 0
        for txn in acct.transactions.order_by("date", "id"):
            checked += 1
            before, running = running, running + txn.amount
            if txn.balance_before != before or txn.balance_after != running:
                txn.balance_before, txn.balance_after = before, running
                to_update.append(txn)
        if to_update:
            AccountTransaction.objects.bulk_update(
                to_update, ["balance_before", "balance_after"], batch_size=500
            )
    return {"account_id": account_id, "checked": checked, "changed": len(to_update)}
