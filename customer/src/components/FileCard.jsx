import { formatDate } from '../utils/dateFormat';

const EXT_ICONS = {
  stl:    { label: 'STL',    color: 'bg-blue-100 text-blue-700' },
  step:   { label: 'STEP',   color: 'bg-indigo-100 text-indigo-700' },
  stp:    { label: 'STP',    color: 'bg-indigo-100 text-indigo-700' },
  f3d:    { label: 'F3D',    color: 'bg-orange-100 text-orange-700' },
  sldprt: { label: 'SLDPRT', color: 'bg-cyan-100 text-cyan-700' },
  pdf:    { label: 'PDF',    color: 'bg-red-100 text-red-700' },
  dxf:    { label: 'DXF',    color: 'bg-teal-100 text-teal-700' },
  svg:    { label: 'SVG',    color: 'bg-pink-100 text-pink-700' },
  ai:     { label: 'AI',     color: 'bg-yellow-100 text-yellow-700' },
};

function getExt(fileName) {
  return (fileName || '').split('.').pop().toLowerCase();
}

export default function FileCard({ file, onClick }) {
  const ext  = getExt(file.fileName);
  const icon = EXT_ICONS[ext] || { label: ext.toUpperCase() || 'FILE', color: 'bg-gray-100 text-gray-700' };

  return (
    <button
      onClick={onClick}
      className="w-full text-left bg-white border border-[#e0e0e0] rounded-xl p-4 hover:border-[#b91c1c]/40 hover:shadow-md transition-all group"
    >
      <div className="flex items-center gap-3 mb-3">
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0 ${icon.color}`}>
          {icon.label}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-[#111] truncate group-hover:text-[#b91c1c] transition-colors">
            {file.fileName}
          </p>
          {file.projectName && (
            <p className="text-xs text-[#555] truncate mt-0.5">
              {file.projectName}
            </p>
          )}
        </div>
      </div>

      {file.projectNumber && (
        <p className="text-xs text-[#555]">Project #{file.projectNumber}</p>
      )}

      <div className="flex items-center justify-between mt-2">
        <span className="text-xs text-[#555]">Click to download</span>
        <svg className="w-4 h-4 text-[#b91c1c] opacity-0 group-hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
      </div>
    </button>
  );
}
