/**
 * Radix Select renders its menu in a portal outside DialogContent. Without
 * cancelling the dialog's outside-interaction event, opening a stage picker
 * can be interpreted as a click outside and close the whole editor before a
 * value is selected. Pipeline changes are intentionally dismissed only via
 * the dialog's explicit close/cancel controls (or Escape).
 */
export function preventPipelineDialogOutsideDismiss(event: { preventDefault: () => void }) {
  event.preventDefault();
}
