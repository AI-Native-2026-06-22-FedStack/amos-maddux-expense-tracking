create index expense_report_case_queue_idx
    on expense_report (tenant_id, current_stage, due_date);

create or replace function prevent_audit_entry_mutation()
returns trigger
language plpgsql
as $$
begin
    raise exception 'audit_entry is append-only; UPDATE and DELETE are not allowed';
end;
$$;

create trigger audit_entry_prevent_update
    before update on audit_entry
    for each row
    execute function prevent_audit_entry_mutation();

create trigger audit_entry_prevent_delete
    before delete on audit_entry
    for each row
    execute function prevent_audit_entry_mutation();
