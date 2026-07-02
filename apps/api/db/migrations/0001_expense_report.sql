create extension if not exists pgcrypto;

create table expense_report (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null,
    submitter_id text not null,
    assigned_owner_id text,
    manager_approver_id text,
    ap_reviewer_id text,
    payment_id text,
    current_stage text not null default 'Drafted',
    priority text not null default 'Normal',
    due_date date,
    on_hold boolean not null default false,
    hold_reason text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint expense_report_tenant_id_id_unique unique (tenant_id, id),
    constraint expense_report_current_stage_check check (
        current_stage in (
            'Drafted',
            'Submitted',
            'Manager Approval',
            'AP Review',
            'Paid',
            'Reconciled'
        )
    ),
    constraint expense_report_priority_check check (
        priority in ('Low', 'Normal', 'High', 'Urgent')
    ),
    constraint expense_report_hold_reason_check check (
        (on_hold = false and hold_reason is null)
        or (on_hold = true and hold_reason is not null)
    )
);

create table expense_line_item (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null,
    expense_report_id uuid not null,
    merchant text not null,
    amount_cents integer not null,
    currency text not null,
    category text not null,
    flagged boolean not null default false,
    flag_cleared boolean not null default false,
    deductible boolean not null default false,
    created_at timestamptz not null default now(),
    constraint expense_line_item_tenant_id_id_unique unique (tenant_id, id),
    constraint expense_line_item_tenant_report_id_id_unique unique (
        tenant_id,
        expense_report_id,
        id
    ),
    constraint expense_line_item_report_fk foreign key (
        tenant_id,
        expense_report_id
    ) references expense_report (tenant_id, id) on delete cascade,
    constraint expense_line_item_amount_cents_check check (amount_cents > 0),
    constraint expense_line_item_currency_check check (currency ~ '^[A-Z]{3}$'),
    constraint expense_line_item_flag_state_check check (
        flag_cleared = false or flagged = true
    )
);

create table attachment_metadata (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null,
    expense_report_id uuid not null,
    uploaded_by_id text not null,
    file_name text not null,
    content_type text not null,
    file_size_bytes integer not null,
    storage_key text not null,
    uploaded_at timestamptz not null default now(),
    constraint attachment_metadata_tenant_id_id_unique unique (tenant_id, id),
    constraint attachment_metadata_tenant_report_id_id_unique unique (
        tenant_id,
        expense_report_id,
        id
    ),
    constraint attachment_metadata_report_fk foreign key (
        tenant_id,
        expense_report_id
    ) references expense_report (tenant_id, id) on delete cascade,
    constraint attachment_metadata_file_size_bytes_check check (file_size_bytes > 0),
    constraint attachment_metadata_storage_key_unique unique (storage_key)
);

create table receipt (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null,
    expense_report_id uuid not null,
    expense_line_item_id uuid not null,
    attachment_metadata_id uuid,
    receipt_number text,
    merchant text,
    receipt_date date,
    amount_cents integer,
    currency text,
    created_at timestamptz not null default now(),
    constraint receipt_tenant_id_id_unique unique (tenant_id, id),
    constraint receipt_report_fk foreign key (
        tenant_id,
        expense_report_id
    ) references expense_report (tenant_id, id) on delete cascade,
    constraint receipt_line_item_report_fk foreign key (
        tenant_id,
        expense_report_id,
        expense_line_item_id
    ) references expense_line_item (
        tenant_id,
        expense_report_id,
        id
    ) on delete cascade,
    constraint receipt_attachment_metadata_fk foreign key (
        tenant_id,
        expense_report_id,
        attachment_metadata_id
    ) references attachment_metadata (
        tenant_id,
        expense_report_id,
        id
    ),
    constraint receipt_amount_cents_check check (
        amount_cents is null or amount_cents > 0
    ),
    constraint receipt_currency_check check (
        currency is null or currency ~ '^[A-Z]{3}$'
    )
);

create table mileage_entry (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null,
    expense_report_id uuid not null,
    trip_date date not null,
    origin text not null,
    destination text not null,
    miles numeric(10, 2) not null,
    business_purpose text not null,
    created_at timestamptz not null default now(),
    constraint mileage_entry_tenant_id_id_unique unique (tenant_id, id),
    constraint mileage_entry_report_fk foreign key (
        tenant_id,
        expense_report_id
    ) references expense_report (tenant_id, id) on delete cascade,
    constraint mileage_entry_miles_check check (miles > 0)
);

create table audit_entry (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null,
    expense_report_id uuid not null,
    actor_id text not null,
    action text not null,
    details text,
    occurred_at timestamptz not null default now(),
    constraint audit_entry_tenant_id_id_unique unique (tenant_id, id),
    constraint audit_entry_report_fk foreign key (
        tenant_id,
        expense_report_id
    ) references expense_report (tenant_id, id) on delete cascade
);

create table stage_transition (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null,
    expense_report_id uuid not null,
    from_stage text not null,
    to_stage text not null,
    actor_id text not null,
    reason text,
    transitioned_at timestamptz not null default now(),
    constraint stage_transition_tenant_id_id_unique unique (tenant_id, id),
    constraint stage_transition_report_fk foreign key (
        tenant_id,
        expense_report_id
    ) references expense_report (tenant_id, id) on delete cascade,
    constraint stage_transition_from_stage_check check (
        from_stage in (
            'Drafted',
            'Submitted',
            'Manager Approval',
            'AP Review',
            'Paid',
            'Reconciled'
        )
    ),
    constraint stage_transition_to_stage_check check (
        to_stage in (
            'Drafted',
            'Submitted',
            'Manager Approval',
            'AP Review',
            'Paid',
            'Reconciled'
        )
    ),
    constraint stage_transition_stage_change_check check (from_stage <> to_stage)
);

create table comment (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null,
    expense_report_id uuid not null,
    author_id text not null,
    body text not null,
    created_at timestamptz not null default now(),
    constraint comment_tenant_id_id_unique unique (tenant_id, id),
    constraint comment_report_fk foreign key (
        tenant_id,
        expense_report_id
    ) references expense_report (tenant_id, id) on delete cascade,
    constraint comment_body_check check (length(trim(body)) > 0)
);
