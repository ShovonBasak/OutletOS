# Owner vs Admin Role Split — Implementation Plan

## Why

Currently the system has two roles: `STAFF` and `OWNER`. The OWNER role is a
catch-all that covers everything non-staff: business monitoring, daily approvals,
catalog management, channel configuration, user management, and system setup.

This conflates two very different personas:

- **Owner (franchisee)** — the person who invested in and runs the outlet.
  Cares about profit, daily performance, and approving purchases. Should not
  need to touch system configuration.
- **Admin** — the system manager (trusted accountant, franchisor IT, or a senior
  manager). Sets up and maintains configuration. Full access.

Separating them prevents the owner from accidentally misconfiguring commissions,
recipes, or user accounts — and gives the admin a distinct scope when supporting
multiple outlets in the future.

---

## Decisions (resolved)

| # | Question | Answer |
|---|----------|--------|
| 1 | Can Owner edit selling prices / channel prices? | **No — Admin only** |
| 2 | Who can do sell corrections? | **Admin only** |
| 3 | Can Staff create/edit expenses? | **Yes — keep as-is** |
| 4 | Single or two accounts for franchisee-who-is-also-admin? | **Single ADMIN account** |
| 5 | Does Admin receive push notifications? | **Yes** |

---

## Role Definitions

### STAFF
Unchanged. Handles the gated daily flow: Day Start → Stock In → Prep → Closing.
Can view catalog and stock. Can create/edit expenses. Cannot see financials or reports.

### OWNER (narrowed from current)
Business monitoring and approvals only. Read-only on all configuration.
- Sees all reports, analytics, and financial data
- Approves/rejects stock-in and locks/reviews daily closings
- Views (but cannot edit) catalog, channels, pricing, team
- Cannot manage users, channels, ingredients, recipes, pricing, or settings

### ADMIN (new — replaces the current OWNER for config tasks)
Superset of Owner. Everything Owner can do, plus:
- Full CRUD on catalog (products, ingredients, recipes, pack definitions)
- Pricing management (selling prices, channel prices, promotions)
- Channel settings (commission rates, settlement types, menu mapping, recompute-commissions)
- User management (create/edit/deactivate Staff and Owner accounts)
- Cost category management
- Outlet settings
- Financial account management
- Sell corrections
- System setup flow (extract ingredients, import menu, map recipes)
- Receives push notifications (same as Owner)

**In a single-outlet launch, one ADMIN account covers all monitoring + configuration.
No separate Owner account is needed unless the business owner wants limited read-only access.**

---

## Permission Matrix

| Feature | Staff | Owner | Admin |
|---------|:-----:|:-----:|:-----:|
| **Dashboard & Analytics** | | | |
| Dashboard (P&L charts, KPIs, channel split) | ✗ | ✓ | ✓ |
| Day overview | ✗ | ✓ | ✓ |
| **Approvals** | | | |
| Stock-in: view list and detail | ✗ | ✓ | ✓ |
| Stock-in: approve / reject | ✗ | ✓ | ✓ |
| Closings: view list and detail | ✗ | ✓ | ✓ |
| Closings: lock / review | ✗ | ✓ | ✓ |
| **Reports** | | | |
| Stock levels | ✗ | ✓ | ✓ |
| Sales report | ✗ | ✓ | ✓ |
| Sell history | ✗ | ✓ | ✓ |
| Stock-in history | ✗ | ✓ | ✓ |
| Settlements | ✗ | ✓ | ✓ |
| Profit & Loss | ✗ | ✓ | ✓ |
| Packaging report | ✗ | ✓ | ✓ |
| **Expenses & Income** | | | |
| Expenses: view | ✓ | ✓ | ✓ |
| Expenses: create / edit | ✓ | ✓ | ✓ |
| Other income: view / create / edit | ✓ | ✓ | ✓ |
| Sell corrections | ✗ | ✗ | ✓ |
| **Financial Accounts** | | | |
| Financial accounts: view | ✗ | ✓ | ✓ |
| Financial accounts: create / edit | ✗ | ✗ | ✓ |
| **Catalog (Products / Ingredients / Recipes)** | | | |
| Products: view | ✓ | ✓ | ✓ |
| Products: add / edit / delete | ✗ | ✗ | ✓ |
| Ingredients: view | ✓ | ✓ | ✓ |
| Ingredients: add / edit / delete | ✗ | ✗ | ✓ |
| Recipes: view | ✓ | ✓ | ✓ |
| Recipes: edit (quantities) | ✗ | ✗ | ✓ |
| Pack definitions: view | ✓ | ✓ | ✓ |
| Pack definitions: add / edit | ✗ | ✗ | ✓ |
| **Pricing** | | | |
| Selling prices & channel prices: view | ✗ | ✓ | ✓ |
| Selling prices & channel prices: edit | ✗ | ✗ | ✓ |
| Channel promotions: view | ✗ | ✓ | ✓ |
| Channel promotions: add / edit | ✗ | ✗ | ✓ |
| **Settings** | | | |
| Sales channels: view (commission, settlement) | ✗ | ✓ | ✓ |
| Sales channels: edit | ✗ | ✗ | ✓ |
| Sales channels: recompute-commissions | ✗ | ✗ | ✓ |
| Menu mapping: view | ✗ | ✓ | ✓ |
| Menu mapping: edit | ✗ | ✗ | ✓ |
| Cost categories: view | ✗ | ✓ | ✓ |
| Cost categories: add / edit | ✗ | ✗ | ✓ |
| Outlet settings: view | ✗ | ✓ | ✓ |
| Outlet settings: edit | ✗ | ✗ | ✓ |
| **Team & Users** | | | |
| Team: view (staff list) | ✗ | ✓ | ✓ |
| Team: add / edit / deactivate users | ✗ | ✗ | ✓ |
| Outlets: add / edit | ✗ | ✗ | ✓ |
| **System Setup** | | | |
| Extract ingredients | ✗ | ✗ | ✓ |
| Import menu | ✗ | ✗ | ✓ |
| Map recipes | ✗ | ✗ | ✓ |
| **Push Notifications** | | | |
| Receive stock-in / closing notifications | ✗ | ✓ | ✓ |

---

## Backend Implementation

### Step 1 — Add ADMIN to Role choices (`accounts/models.py`)

```python
class Role(models.TextChoices):
    STAFF = "STAFF", "Staff"
    OWNER = "OWNER", "Owner"
    ADMIN = "ADMIN", "Admin"
```

Add convenience properties on `User`:
```python
@property
def is_admin(self):
    return self.role == Role.ADMIN

@property
def is_owner_or_admin(self):
    return self.role in (Role.OWNER, Role.ADMIN)
```

Update `create_superuser` to default to `Role.ADMIN` (was `Role.OWNER`).

Run: `python manage.py makemigrations accounts`

### Step 2 — New permission classes (`accounts/permissions.py`)

```python
class IsAdmin(BasePermission):
    """Only ADMIN role."""
    def has_permission(self, request, view):
        return bool(request.user and request.user.is_authenticated and request.user.is_admin)

class IsOwnerOrAdmin(BasePermission):
    """OWNER or ADMIN — both can perform this action."""
    def has_permission(self, request, view):
        return bool(request.user and request.user.is_authenticated and request.user.is_owner_or_admin)

class IsOwnerOrAdminOrReadOnly(BasePermission):
    """Any authenticated user can read; OWNER or ADMIN can write."""
    def has_permission(self, request, view):
        if not (request.user and request.user.is_authenticated):
            return False
        if request.method in SAFE_METHODS:
            return True
        return request.user.is_owner_or_admin

class IsAdminOrReadOnly(BasePermission):
    """Any authenticated user can read; only ADMIN can write."""
    def has_permission(self, request, view):
        if not (request.user and request.user.is_authenticated):
            return False
        if request.method in SAFE_METHODS:
            return True
        return request.user.is_admin
```

Keep existing `IsOwner` and `IsOwnerOrReadOnly` until all references are replaced,
then delete them.

### Step 3 — Re-map permissions per view

| App | ViewSet / View | Old permission | New permission |
|-----|----------------|---------------|----------------|
| `catalog` | `OutletViewSet` | `IsOwnerOrReadOnly` | `IsAdminOrReadOnly` |
| `catalog` | `ProductViewSet` | `IsOwnerOrReadOnly` | `IsAdminOrReadOnly` |
| `catalog` | `IngredientViewSet` | `IsOwnerOrReadOnly` | `IsAdminOrReadOnly` |
| `catalog` | `PackDefinitionViewSet` | `IsOwnerOrReadOnly` | `IsAdminOrReadOnly` |
| `catalog` | `RecipeViewSet` | `IsOwnerOrReadOnly` | `IsAdminOrReadOnly` |
| `catalog` | `SupplierAliasViewSet` | `IsOwnerOrReadOnly` | `IsAdminOrReadOnly` |
| `catalog` | `ComboComponentViewSet` | `IsOwnerOrReadOnly` | `IsAdminOrReadOnly` |
| `sales` | `SalesChannelViewSet` | `IsOwnerOrReadOnly` | `IsAdminOrReadOnly` |
| `sales` | `ChannelMenuMapViewSet` | `IsOwnerOrReadOnly` | `IsAdminOrReadOnly` |
| `sales` | `ChannelPromotionViewSet` | `IsOwnerOrReadOnly` | `IsAdminOrReadOnly` |
| `sales` | `ChannelPriceViewSet` | `IsOwnerOrReadOnly` | `IsAdminOrReadOnly` |
| `closing` | `DailyChannelDiscountViewSet` | `IsOwnerOrReadOnly` | `IsOwnerOrAdminOrReadOnly` |
| `closing` | `DailyClosingViewSet.lock` | `IsOwner` | `IsOwnerOrAdmin` |
| `closing` | `SellCorrectionViewSet` | `IsOwnerOrReadOnly` | `IsAdminOrReadOnly` |
| `stock` | `StockInRecord.approve/reject` | `IsOwner` | `IsOwnerOrAdmin` |
| `stock` | `StockInRecord.revert` | `IsOwner` | `IsOwnerOrAdmin` |
| `costs` | `CostCategoryViewSet` | `IsOwnerOrReadOnly` | `IsAdminOrReadOnly` |
| `costs` | `ExpenseViewSet` | `IsOwnerOrReadOnly` | `IsOwnerOrAdminOrReadOnly` |
| `finance` | `FinancialAccountViewSet` (write) | `IsOwner` | `IsAdmin` |
| `income` | `OtherIncomeViewSet` | `IsOwnerOrReadOnly` | `IsOwnerOrAdminOrReadOnly` |
| `accounts` | `UserViewSet` (team write) | `IsOwner` | `IsAdmin` |
| `reports` | all report views | `IsOwner` | `IsOwnerOrAdmin` |

### Step 4 — Push notifications (`accounts/push.py`)

```python
# Before
subs = PushSubscription.objects.filter(user__role=Role.OWNER)

# After
subs = PushSubscription.objects.filter(user__role__in=[Role.OWNER, Role.ADMIN])
```

### Step 5 — User management endpoints (verify these exist)

`POST /users/`, `PATCH /users/<id>/`, `POST /users/<id>/deactivate/` must all be
guarded by `IsAdmin`. `GET /users/` stays open to `IsOwnerOrAdmin` (owner can
view the team list).

---

## Frontend Implementation

### Step 1 — Expose role in auth context

The `/auth/me/` response and JWT payload must include `role: "STAFF" | "OWNER" | "ADMIN"`.
Extend `useUser()` (or equivalent auth hook) with:

```ts
const isAdmin       = user.role === "ADMIN";
const isOwnerOrAdmin = user.role === "OWNER" || user.role === "ADMIN";
```

### Step 2 — Login routing

No new route needed. ADMIN lands on `/owner/*` exactly like OWNER.
Role gates within each page control what is visible and editable.

```ts
// Existing login redirect logic — add ADMIN case:
if (role === "STAFF")            router.push("/staff");
if (role === "OWNER" || role === "ADMIN") router.push("/owner");
```

### Step 3 — Navigation (`nav.ts`)

Build two nav configs — or a single config with an `adminOnly` flag — and filter
at render time based on `isAdmin`.

**Items visible to OWNER (read-only context):**
- All Overview, Approvals, Reports groups (unchanged)
- Manage: Expenses, Other income, Financial accounts (view), Team (view)
- Settings: all items visible as read-only

**Items hidden from OWNER (Admin only):**
- Manage → Sell corrections
- Setup group (Extract ingredients, Import menu, Map recipes)

**Reorganise for ADMIN — add an "Administration" nav group:**
```
Administration  [ADMIN only]
  ├── Products & recipes      /owner/products
  ├── Cost categories         /owner/settings/cost-categories
  ├── Sales channels          /owner/settings/channels
  ├── Menu mapping            /owner/settings/menu-mapping
  ├── Outlet                  /owner/settings/outlet
  └── Team & users            /owner/team

Setup  [ADMIN only]
  ├── Extract ingredients     /owner/setup/extract
  ├── Import menu             /owner/setup/import-menu
  └── Map recipes             /owner/setup/map-recipes
```

Remove these items from the generic "Settings" and "Manage" groups so they appear
only once, under "Administration".

### Step 4 — Per-page edit-control gating

Every page with write actions renders those controls conditionally. Pattern:

```tsx
const { isAdmin, isOwnerOrAdmin } = useUser();

// Admin-only controls (catalog edits, pricing, channel config)
{isAdmin && <button onClick={handleEdit}>Edit</button>}
{isAdmin && <button onClick={handleDelete}>Delete</button>}
{isAdmin && <button onClick={handleAdd}>+ Add product</button>}

// Owner+Admin controls (approvals, locking)
{isOwnerOrAdmin && <button onClick={handleApprove}>Approve</button>}
```

**Pages that need gating — Admin-only write controls:**

| Page | Controls to gate |
|------|-----------------|
| `/owner/products` | Add, Edit, Delete, Edit recipe |
| `/owner/settings/channels` | Commission input, Save, Recompute history |
| `/owner/settings/pricing` | All edit inputs, Save |
| `/owner/settings/cost-categories` | Add, Edit |
| `/owner/settings/outlet` | Edit form |
| `/owner/settings/menu-mapping` | All mapping edits |
| `/owner/team` | Add user, Edit user, Deactivate |
| `/owner/accounts` (financial) | Add account, Edit account |
| `/owner/sell-corrections` | Entire page hidden for Owner |
| `/owner/setup/*` | Entire group hidden for Owner |

**Pages where Owner and Admin both have write access (no change needed):**
- `/owner/stock-in` — approve/reject
- `/owner/closings` — lock/review
- `/owner/expenses` — create/edit
- `/owner/other-income` — create/edit

---

## Migration Strategy

### Order of operations

1. **Backend first** — deploy with ADMIN role added and new permission classes.
   Existing OWNER accounts are unaffected because `IsOwnerOrAdmin` covers everything
   they currently have. Only net-new `IsAdminOrReadOnly` guards restrict future
   OWNER accounts from writing catalog/pricing/settings.

2. **Promote the operating account to ADMIN** before deploying the frontend:
   ```python
   # Django shell or management command
   User.objects.filter(phone="<current-owner-phone>").update(role="ADMIN")
   ```
   This account now has full access. No OWNER account is needed separately.

3. **Deploy frontend** — the ADMIN account sees the full admin nav and all edit
   controls. If any pure OWNER accounts exist, they now see read-only views for
   catalog, pricing, and settings.

4. **Create pure OWNER accounts** (optional) — only if the franchise owner wants
   a monitoring-only login separate from the admin login.

### No data migration required

Only `accounts_user.role` values change. All records (stock-in, closings, recipes,
etc.) are unaffected.
