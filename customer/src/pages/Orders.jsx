import { useState, useMemo } from 'react';
import Fuse from 'fuse.js';
import OrderCard from '../components/OrderCard';
import Modal from '../components/Modal';
import OrderDetail from '../components/OrderDetail';
import SearchFilterBar from '../components/SearchFilterBar';
import { exportToCSV } from '../utils/csv';
import { formatDate } from '../utils/dateFormat';

const ORDER_STATUSES = ['Quote Request', 'New', 'Printing', 'Shipped', 'Complete'];

function applySort(arr, sort) {
  return [...arr].sort((a, b) => {
    if (sort === 'oldest')     return new Date(a.createdAt) - new Date(b.createdAt);
    if (sort === 'price-high') return (b.total || 0) - (a.total || 0);
    if (sort === 'price-low')  return (a.total || 0) - (b.total || 0);
    return new Date(b.createdAt) - new Date(a.createdAt); // newest
  });
}

export default function Orders({ orders, title = 'Orders' }) {
  const [search, setSearch]   = useState('');
  const [status, setStatus]   = useState('');
  const [sort, setSort]       = useState('newest');
  const [selected, setSelected] = useState(null);

  const fuse = useMemo(() => new Fuse(orders, {
    keys: ['projectName', 'projectNumber', 'notes', 'customerName'],
    threshold: 0.35,
  }), [orders]);

  const filtered = useMemo(() => {
    let result = search ? fuse.search(search).map(r => r.item) : orders;
    if (status) result = result.filter(o => o.status === status);
    return applySort(result, sort);
  }, [orders, search, status, sort, fuse]);

  function handleExport() {
    exportToCSV(
      filtered.map(o => ({
        'Project #': o.projectNumber || '',
        'Project Name': o.projectName || '',
        'Status': o.status || '',
        'Date': formatDate(o.createdAt),
        'Subtotal': o.subtotal || 0,
        'Tax': o.tax || 0,
        'Total': o.total || 0,
        'Payment': o.paymentStatus || '',
      })),
      `orders-${new Date().toISOString().slice(0,10)}.csv`
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-[#111]">{title}</h1>
        {filtered.length > 0 && (
          <button
            onClick={handleExport}
            className="flex items-center gap-2 px-3 py-2 text-sm border border-[#e0e0e0] rounded-lg text-[#555] hover:bg-[#f1f1f1] transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Export CSV
          </button>
        )}
      </div>

      <div className="mb-5">
        <SearchFilterBar
          search={search}     onSearch={setSearch}
          status={status}     onStatus={setStatus}
          sort={sort}         onSort={setSort}
          statusOptions={ORDER_STATUSES}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="py-20 text-center">
          <div className="text-4xl mb-3">📦</div>
          <p className="text-[#555] text-sm">
            {search || status ? 'No orders match your filters.' : 'No orders yet.'}
          </p>
          {(search || status) && (
            <button
              onClick={() => { setSearch(''); setStatus(''); }}
              className="mt-3 text-sm text-[#b91c1c] hover:underline"
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <>
          <p className="text-xs text-[#555] mb-4">{filtered.length} result{filtered.length !== 1 ? 's' : ''}</p>
          <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {filtered.map(order => (
              <OrderCard key={order.id} order={order} onClick={() => setSelected(order)} />
            ))}
          </div>
        </>
      )}

      <Modal
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.projectName || 'Order Detail'}
        wide
      >
        {selected && <OrderDetail order={selected} onClose={() => setSelected(null)} />}
      </Modal>
    </div>
  );
}
