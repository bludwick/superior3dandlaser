export default function SearchFilterBar({ search, onSearch, status, onStatus, sort, onSort, statusOptions }) {
  return (
    <div className="flex flex-col sm:flex-row gap-3">
      <div className="relative flex-1">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#555]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          placeholder="Search by project name, number, or notes..."
          value={search}
          onChange={e => onSearch(e.target.value)}
          className="w-full pl-10 pr-4 py-2.5 text-sm border border-[#e0e0e0] rounded-lg focus:outline-none focus:border-[#b91c1c] transition-colors"
        />
        {search && (
          <button
            onClick={() => onSearch('')}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-[#555] hover:text-[#111]"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      <select
        value={status}
        onChange={e => onStatus(e.target.value)}
        className="px-3 py-2.5 text-sm border border-[#e0e0e0] rounded-lg focus:outline-none focus:border-[#b91c1c] bg-white text-[#111]"
      >
        <option value="">All Statuses</option>
        {(statusOptions || []).map(s => (
          <option key={s} value={s}>{s}</option>
        ))}
      </select>

      <select
        value={sort}
        onChange={e => onSort(e.target.value)}
        className="px-3 py-2.5 text-sm border border-[#e0e0e0] rounded-lg focus:outline-none focus:border-[#b91c1c] bg-white text-[#111]"
      >
        <option value="newest">Newest First</option>
        <option value="oldest">Oldest First</option>
        <option value="price-high">Price: High to Low</option>
        <option value="price-low">Price: Low to High</option>
      </select>
    </div>
  );
}
