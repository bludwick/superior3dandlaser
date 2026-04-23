import { useState, useMemo, useEffect } from 'react';
import Fuse from 'fuse.js';
import FileCard from '../components/FileCard';
import Modal from '../components/Modal';
import { api } from '../utils/api';

export default function CADModels({ orders }) {
  const [search, setSearch]     = useState('');
  const [selected, setSelected] = useState(null);
  const [signedUrls, setSignedUrls] = useState({});
  const [loadingUrls, setLoadingUrls] = useState(false);

  // Collect all files from all orders
  const allFiles = useMemo(() => {
    const files = [];
    for (const order of orders) {
      for (const f of order.stlFiles || []) {
        files.push({
          ...f,
          orderId:       order.id,
          projectName:   order.projectName,
          projectNumber: order.projectNumber,
          orderDate:     order.createdAt,
        });
      }
    }
    return files;
  }, [orders]);

  const fuse = useMemo(() => new Fuse(allFiles, {
    keys: ['fileName', 'projectName', 'projectNumber'],
    threshold: 0.35,
  }), [allFiles]);

  const filtered = useMemo(() =>
    search ? fuse.search(search).map(r => r.item) : allFiles,
    [allFiles, search, fuse]
  );

  // Fetch signed URLs from API
  useEffect(() => {
    if (!allFiles.length) return;
    setLoadingUrls(true);
    api.get('/api/customer/files')
      .then(files => {
        const map = {};
        for (const f of files) map[f.blobKey] = f.downloadUrl;
        setSignedUrls(map);
      })
      .catch(() => { /* demo mode — no signed URLs */ })
      .finally(() => setLoadingUrls(false));
  }, [allFiles.length]);

  function handleFileClick(file) {
    const url = signedUrls[file.blobKey];
    if (url) {
      window.open(url, '_blank', 'noopener');
    } else {
      setSelected(file);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-[#111]">CAD Models</h1>
        <span className="text-sm text-[#555]">{allFiles.length} file{allFiles.length !== 1 ? 's' : ''}</span>
      </div>

      <div className="mb-5">
        <div className="relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#555]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="Search files…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 text-sm border border-[#e0e0e0] rounded-lg focus:outline-none focus:border-[#b91c1c] transition-colors max-w-sm"
          />
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="py-20 text-center">
          <div className="text-4xl mb-3">📁</div>
          <p className="text-[#555] text-sm">
            {search ? 'No files match your search.' : 'No CAD files uploaded yet.'}
          </p>
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filtered.map((file, i) => (
            <FileCard
              key={i}
              file={file}
              onClick={() => handleFileClick(file)}
            />
          ))}
        </div>
      )}

      {/* File detail modal (when no signed URL available) */}
      <Modal
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.fileName || 'File Details'}
      >
        {selected && (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs font-semibold text-[#555] uppercase tracking-wide mb-1">Filename</p>
                <p className="font-mono text-[#111]">{selected.fileName}</p>
              </div>
              <div>
                <p className="text-xs font-semibold text-[#555] uppercase tracking-wide mb-1">Project</p>
                <p className="text-[#111]">{selected.projectName}</p>
                <p className="text-[#555] text-xs">#{selected.projectNumber}</p>
              </div>
            </div>
            <p className="text-[#555] text-xs">
              Sign in with your account to download this file, or contact{' '}
              <a href="mailto:sales@superior3dandlaser.com" className="text-[#b91c1c] hover:underline">
                sales@superior3dandlaser.com
              </a>.
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
