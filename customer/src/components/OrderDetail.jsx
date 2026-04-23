import StatusBadge from './StatusBadge';
import { formatDate, formatDateTime } from '../utils/dateFormat';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
import { useRef, useState } from 'react';

const STATUS_STEPS = ['Quote Request', 'New', 'Printing', 'Shipped', 'Complete'];

export default function OrderDetail({ order, onClose }) {
  const [downloading, setDownloading] = useState(false);
  const invoiceRef = useRef(null);

  const stepIdx = STATUS_STEPS.indexOf(order.status);

  async function downloadPDF() {
    if (!invoiceRef.current) return;
    setDownloading(true);
    try {
      const canvas = await html2canvas(invoiceRef.current, { scale: 2, useCORS: true });
      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const w = pdf.internal.pageSize.getWidth();
      const h = (canvas.height * w) / canvas.width;
      pdf.addImage(imgData, 'PNG', 0, 0, w, h);
      pdf.save(`invoice-${order.projectNumber || order.id}.pdf`);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div>
      {/* Actions */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <StatusBadge status={order.status} />
          {order.paymentStatus === 'paid' && (
            <span className="ml-2 text-xs text-green-600 font-medium">✓ Paid {formatDate(order.paidAt)}</span>
          )}
        </div>
        <button
          onClick={downloadPDF}
          disabled={downloading}
          className="flex items-center gap-2 px-4 py-2 bg-[#b91c1c] text-white text-sm rounded-lg hover:bg-[#dc2626] transition-colors disabled:opacity-60"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
          </svg>
          {downloading ? 'Generating…' : 'Download PDF'}
        </button>
      </div>

      {/* Status timeline */}
      <div className="mb-6 p-4 bg-[#f8f8f8] rounded-xl">
        <p className="text-xs font-semibold text-[#555] uppercase tracking-wide mb-3">Order Progress</p>
        <div className="flex items-center gap-0">
          {STATUS_STEPS.map((step, i) => (
            <div key={step} className="flex items-center flex-1 last:flex-none">
              <div className="flex flex-col items-center">
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-colors ${
                  i <= stepIdx ? 'bg-[#b91c1c] text-white' : 'bg-[#e0e0e0] text-[#555]'
                }`}>
                  {i < stepIdx ? '✓' : i + 1}
                </div>
                <span className={`text-[10px] mt-1 text-center whitespace-nowrap ${
                  i <= stepIdx ? 'text-[#b91c1c] font-medium' : 'text-[#555]'
                }`}>
                  {step}
                </span>
              </div>
              {i < STATUS_STEPS.length - 1 && (
                <div className={`flex-1 h-0.5 mx-1 mb-4 ${i < stepIdx ? 'bg-[#b91c1c]' : 'bg-[#e0e0e0]'}`} />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Invoice area */}
      <div ref={invoiceRef} className="bg-white">
        {/* Header */}
        <div className="border-b border-[#e0e0e0] pb-4 mb-4">
          <h3 className="text-xl font-bold text-[#b91c1c]">INVOICE</h3>
          <p className="text-sm text-[#555]">Superior 3D and Laser</p>
        </div>

        {/* Meta grid */}
        <div className="grid grid-cols-2 gap-6 mb-6 text-sm">
          <div>
            <p className="text-xs font-semibold text-[#555] uppercase tracking-wide mb-2">Project</p>
            <p className="font-medium text-[#111]">{order.projectName || '—'}</p>
            <p className="text-[#555]">#{order.projectNumber || order.id}</p>
            <p className="text-[#555] mt-1">{formatDate(order.createdAt)}</p>
          </div>
          <div>
            <p className="text-xs font-semibold text-[#555] uppercase tracking-wide mb-2">Bill To</p>
            <p className="font-medium text-[#111]">{order.customerName}</p>
            <p className="text-[#555]">{order.customerEmail}</p>
            {order.phone && <p className="text-[#555]">{order.phone}</p>}
          </div>
        </div>

        {/* Line items */}
        <table className="w-full text-sm mb-4">
          <thead>
            <tr className="bg-[#f8f8f8] text-xs font-semibold text-[#555] uppercase tracking-wide">
              <th className="text-left py-2 px-3 rounded-l-lg">Item</th>
              <th className="text-left py-2 px-3">Material</th>
              <th className="text-center py-2 px-3">Qty</th>
              <th className="text-right py-2 px-3">Unit</th>
              <th className="text-right py-2 px-3 rounded-r-lg">Total</th>
            </tr>
          </thead>
          <tbody>
            {(order.items || []).map((item, i) => (
              <tr key={i} className="border-b border-[#f1f1f1]">
                <td className="py-2.5 px-3 text-[#111]">{item.partName || item.projectName || 'Item'}</td>
                <td className="py-2.5 px-3 text-[#555]">{item.material}{item.color ? ` / ${item.color}` : ''}</td>
                <td className="py-2.5 px-3 text-center text-[#555]">{item.qty}</td>
                <td className="py-2.5 px-3 text-right text-[#555]">${(item.unitPrice || 0).toFixed(2)}</td>
                <td className="py-2.5 px-3 text-right font-medium text-[#111]">${(item.lineTotal || 0).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Totals */}
        <div className="flex justify-end mb-4">
          <div className="w-48 text-sm space-y-1">
            <div className="flex justify-between text-[#555]">
              <span>Subtotal</span>
              <span>${(order.subtotal || 0).toFixed(2)}</span>
            </div>
            <div className="flex justify-between text-[#555]">
              <span>Tax</span>
              <span>${(order.tax || 0).toFixed(2)}</span>
            </div>
            <div className="flex justify-between font-bold text-[#111] text-base border-t border-[#e0e0e0] pt-2 mt-2">
              <span>Total</span>
              <span>${(order.total || 0).toFixed(2)}</span>
            </div>
          </div>
        </div>

        {order.notes && (
          <div className="bg-[#f8f8f8] rounded-lg p-3 text-sm text-[#555]">
            <span className="font-medium text-[#111]">Notes: </span>{order.notes}
          </div>
        )}
      </div>

      {/* Files */}
      {order.stlFiles?.length > 0 && (
        <div className="mt-6">
          <p className="text-sm font-semibold text-[#111] mb-3">
            Uploaded Files ({order.stlFiles.length})
          </p>
          <div className="space-y-2">
            {order.stlFiles.map((f, i) => (
              <div key={i} className="flex items-center gap-3 p-3 bg-[#f8f8f8] rounded-lg text-sm">
                <span className="font-mono text-[#111]">{f.fileName}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
