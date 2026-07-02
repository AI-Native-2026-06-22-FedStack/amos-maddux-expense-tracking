alter table audit_entry
    drop constraint audit_entry_report_fk,
    add constraint audit_entry_report_fk foreign key (
        tenant_id,
        expense_report_id
    ) references expense_report (tenant_id, id) on delete restrict;

alter table stage_transition
    drop constraint stage_transition_report_fk,
    add constraint stage_transition_report_fk foreign key (
        tenant_id,
        expense_report_id
    ) references expense_report (tenant_id, id) on delete restrict;

alter table attachment_metadata
    drop constraint attachment_metadata_storage_key_unique,
    add constraint attachment_metadata_storage_key_unique unique (
        tenant_id,
        storage_key
    );
