const colors = {
  'Quote Request': 'bg-purple-100 text-purple-700',
  'New':           'bg-blue-100 text-blue-700',
  'Printing':      'bg-yellow-100 text-yellow-700',
  'Shipped':       'bg-orange-100 text-orange-700',
  'Complete':      'bg-green-100 text-green-700',
  'confirmed':     'bg-blue-100 text-blue-700',
  'printing':      'bg-yellow-100 text-yellow-700',
  'ready':         'bg-teal-100 text-teal-700',
  'complete':      'bg-green-100 text-green-700',
};

export default function StatusBadge({ status }) {
  const cls = colors[status] || 'bg-gray-100 text-gray-600';
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {status || 'Unknown'}
    </span>
  );
}
