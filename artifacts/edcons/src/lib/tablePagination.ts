export function clampClientPaginationPage(
  page: number,
  pageSize: number,
  totalItems: number | null,
): number {
  if (totalItems === null) return page;

  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  return Math.min(page, totalPages);
}
