with default_tenant as (
    select '00000000-0000-4000-8000-000000000001'::uuid as tenant_id
),
upsert_codes as (
    insert into gl_code (
        tenant_id,
        account_code,
        account_name,
        normal_balance
    )
    select default_tenant.tenant_id, seed.account_code, seed.account_name, 'debit'
    from default_tenant
    cross join (
        values
            ('6100', 'Synthetic Meals Expense'),
            ('6200', 'Synthetic Lodging Expense'),
            ('6300', 'Synthetic Mileage Expense'),
            ('6400', 'Synthetic Supplies Expense'),
            ('6900', 'Synthetic Other Expense')
    ) as seed(account_code, account_name)
    on conflict (tenant_id, account_code) do update
    set
        account_name = excluded.account_name,
        normal_balance = excluded.normal_balance,
        active = true,
        updated_at = now()
    returning id, tenant_id, account_code
)
insert into gl_mapping (
    tenant_id,
    category,
    gl_code_id
)
select upsert_codes.tenant_id, seed.category, upsert_codes.id
from upsert_codes
join (
    values
        ('Meals', '6100'),
        ('Lodging', '6200'),
        ('Mileage', '6300'),
        ('Supplies', '6400'),
        ('Other', '6900')
) as seed(category, account_code) on seed.account_code = upsert_codes.account_code
on conflict (tenant_id, category) do update
set
    gl_code_id = excluded.gl_code_id,
    updated_at = now();
