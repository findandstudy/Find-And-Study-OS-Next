LOCK TABLE public.change_set_command_audit_events IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.change_set_command_audit_events
  DROP CONSTRAINT change_set_command_audit_events_phase_chk,
  DROP CONSTRAINT change_set_command_audit_events_outcome_chk,
  DROP CONSTRAINT change_set_command_audit_events_reason_chk,
  ADD CONSTRAINT change_set_command_audit_events_phase_chk
    CHECK (
      phase IN (
        'ATTEMPT_STARTED', 'AUTHORIZATION', 'CLAIM', 'EVIDENCE',
        'MUTATION', 'COMMIT', 'RECONCILIATION', 'TERMINAL'
      )
    ),
  ADD CONSTRAINT change_set_command_audit_events_outcome_chk
    CHECK (
      (phase = 'ATTEMPT_STARTED' AND outcome = 'STARTED')
      OR (phase = 'AUTHORIZATION' AND outcome = 'ALLOW')
      OR (phase IN ('CLAIM', 'EVIDENCE', 'MUTATION', 'COMMIT') AND outcome = 'SUCCESS')
      OR (phase = 'RECONCILIATION' AND outcome = 'PENDING')
      OR (phase = 'TERMINAL' AND outcome IN ('DENY', 'REJECT', 'CONFLICT', 'ERROR', 'SUCCESS'))
    ),
  ADD CONSTRAINT change_set_command_audit_events_reason_chk
    CHECK (
      (phase = 'ATTEMPT_STARTED' AND outcome = 'STARTED' AND reason_code = 'REQUEST_ACCEPTED')
      OR (phase = 'AUTHORIZATION' AND outcome = 'ALLOW' AND reason_code = 'AUTHORIZED')
      OR (phase = 'CLAIM' AND outcome = 'SUCCESS' AND reason_code = 'CLAIMED')
      OR (phase = 'EVIDENCE' AND outcome = 'SUCCESS' AND reason_code = 'EVIDENCE_ACCEPTED')
      OR (phase = 'MUTATION' AND outcome = 'SUCCESS' AND reason_code = 'MUTATION_APPLIED')
      OR (phase = 'COMMIT' AND outcome = 'SUCCESS' AND reason_code = 'COMMIT_CONFIRMED')
      OR (
        phase = 'RECONCILIATION'
        AND outcome = 'PENDING'
        AND reason_code = 'COMMIT_OUTCOME_UNKNOWN'
      )
      OR (
        phase = 'TERMINAL'
        AND outcome = 'SUCCESS'
        AND reason_code IN ('COMMAND_COMPLETED', 'COMMAND_RECONCILED')
      )
      OR (phase = 'TERMINAL' AND outcome = 'DENY' AND reason_code = 'AUTHORIZATION_DENIED')
      OR (
        phase = 'TERMINAL'
        AND outcome = 'REJECT'
        AND reason_code IN ('EVIDENCE_REJECTED', 'MUTATION_REJECTED')
      )
      OR (
        phase = 'TERMINAL'
        AND outcome = 'CONFLICT'
        AND reason_code IN ('IDEMPOTENCY_CONFLICT', 'COMMAND_IN_PROGRESS')
      )
      OR (phase = 'TERMINAL' AND outcome = 'ERROR' AND reason_code = 'INTERNAL_ERROR')
    );
