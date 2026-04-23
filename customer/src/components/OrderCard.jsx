import StatusBadge from './StatusBadge';
import { formatDate } from '../utils/dateFormat';

export default function OrderCard({ order, onClick }) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left bg-white border border-[#e0e0e0] rounded-xl p-5 hover:border-[#b91c1c]/40 hover:shadow-md transition-all group"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <p className="font-semibold text-[#111] truncate group-hover:text-[#b91c1c] transition-colors">
            {order.projectName || 'Unnamed Project'}
          </p>
          <p className="text-xs text-[#555] mt-0.5">#{order.projectNumber || order.id?.slice(-6)}</p>
        </div>
        <StatusBadge status={order.status} />
      </div>

      <div className="flex items-center justify-between text-sm">
        <span className="text-[#555]">{formatDate(order.createdAt)}</span>
        <span className="font-semibold text-[#111]">
          ${(order.total || 0).toFixed(2)}
        </span>
      </div>

      {order.items?.length > 0 && (
        <p className="text-xs text-[#555] mt-2 truncate">
          {order.items.map(i => i.partName || i.projectName || 'Item').join(' · ')}
        </p>
      )}

      <div className="flex items-center gap-2 mt-3">
        {order.paymentStatus === 'paid' ? (
          <span className="text-xs text-green-600 flex items-center gap-1">
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            Paid
          </span>
        ) : (
          <span className="text-xs text-[#555]">Awaiting payment</span>
        )}
        {order.stlFiles?.length > 0 && (
          <span className="text-xs text-[#555] ml-auto">
            {order.stlFiles.length} file{order.stlFiles.length !== 1 ? 's' : ''}
          </span>
        )}
      </div>
    </button>
  );
}
