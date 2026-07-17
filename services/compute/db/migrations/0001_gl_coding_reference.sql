create extension if not exists pgcrypto;

create table gl_code (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null,
    account_code text not null,
    account_name text not null,
    normal_balance text not null,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint gl_code_tenant_id_id_unique unique (tenant_id, id),
    constraint gl_code_tenant_account_code_unique unique (tenant_id, account_code),
    constraint gl_code_normal_balance_check check (normal_balance in ('debit', 'credit')),
    constraint gl_code_account_code_not_blank_check check (length(trim(account_code)) > 0),
    constraint gl_code_account_name_not_blank_check check (length(trim(account_name)) > 0)
);

create table gl_mapping (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null,
    category text not null,
    gl_code_id uuid not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint gl_mapping_tenant_id_id_unique unique (tenant_id, id),
    constraint gl_mapping_tenant_category_unique unique (tenant_id, category),
    constraint gl_mapping_category_check check (
        category in ('Meals', 'Lodging', 'Mileage', 'Supplies', 'Other')
    ),
    constraint gl_mapping_gl_code_fk foreign key (
        tenant_id,
        gl_code_id
    ) references gl_code (tenant_id, id) on delete restrict
);

create index gl_mapping_tenant_gl_code_idx on gl_mapping (tenant_id, gl_code_id);
