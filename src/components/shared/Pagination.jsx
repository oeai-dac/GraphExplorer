export function Pagination({ page, pages, onChange }) {
  if (pages <= 1) return null
  return (
    <div className="pag">
      <button disabled={page === 0} onClick={() => onChange(page - 1)}>‹</button>
      <span>{page + 1} / {pages}</span>
      <button disabled={page >= pages - 1} onClick={() => onChange(page + 1)}>›</button>
    </div>
  )
}
