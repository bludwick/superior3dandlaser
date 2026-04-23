import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import StatusBadge from '../components/StatusBadge';
import { formatDate, timeAgo } from '../utils/dateFormat';

export default function Dashboard({ orders }) {
  const { user } = useAuth();

  const stats = useMemo(() => {
    const total     = orders.length;
    const active    = orders.filter(o => !['Complete', 'Shipped'].includes(o.status)).length;
    const spent     = orders.filter(o => o.paymentStatus === 'paid').reduce((s, o) => s + (o.total || 0), 0);
    const files     = orders.reduce((s, o) => s + (o.stlFiles?.length || 0), 0);
    return { total, active, spent, files };
  }, [orders]);

  const recent = useMemo(
    () => [...orders].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5),
    [orders]
  );

  const greeting = getGreeting();

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-[#111]">
          {greeting}, {user?.name?.split(' ')[0] || 'there'}!
        </h1>
        <p className="text-[#555] text-sm mt-1">Here's a summary of your account.</p>
      </div>

      {/* Stats cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Total Orders" value={stats.total} icon="📦" />
        <StatCard label="Active Orders" value={stats.active} icon="⚙️" accent />
        <StatCard label="Total Spent" value={`$${stats.spent.toFixed(2)}`} icon="💳" />
        <StatCard label="Files Uploaded" value={stats.files} icon="📁" />
      </div>

      {/* Recent activity */}
      <div className="grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-[#111]">Recent Orders</h2>
            <Link to="/orders" className="text-sm text-[#b91c1c] hover:underline">View all</Link>
          </div>
          <div className="bg-white rounded-xl border border-[#e0e0e0] overflow-hidden">
            {recent.length === 0 ? (
              <div className="py-12 text-center text-[#555] text-sm">No orders yet.</div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-[#f8f8f8] text-xs font-semibold text-[#555] uppercase tracking-wide">
                    <th className="text-left py-3 px-4">Project</th>
                    <th className="text-left py-3 px-4 hidden sm:table-cell">Date</th>
                    <th className="text-left py-3 px-4">Status</th>
                    <th className="text-right py-3 px-4">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map(order => (
                    <tr key={order.id} className="border-t border-[#f1f1f1] hover:bg-[#f8f8f8] transition-colors">
                      <td className="py-3 px-4">
                        <p className="font-medium text-[#111] truncate max-w-[160px]">
                          {order.projectName || 'Unnamed Project'}
                        </p>
                        <p className="text-xs text-[#555]">#{order.projectNumber || '—'}</p>
                      </td>
                      <td className="py-3 px-4 text-[#555] hidden sm:table-cell">{formatDate(order.createdAt)}</td>
                      <td className="py-3 px-4"><StatusBadge status={order.status} /></td>
                      <td className="py-3 px-4 text-right font-medium text-[#111]">
                        ${(order.total || 0).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        {/* Quick links */}
        <div>
          <h2 className="font-semibold text-[#111] mb-4">Quick Actions</h2>
          <div className="space-y-3">
            <QuickLink to="/quotes"  label="View Quotes"      sub={`${orders.filter(o => o.source === 'quote').length} total`}       icon="📄" />
            <QuickLink to="/orders"  label="Track Orders"     sub={`${stats.active} active`}                                          icon="📦" />
            <QuickLink to="/models"  label="My CAD Files"     sub={`${stats.files} uploaded`}                                         icon="🔧" />
            <QuickLink to="/account" label="Account Settings" sub="Update your info"                                                  icon="⚙️" />
          </div>

          <div className="mt-6 p-4 bg-[#b91c1c]/5 border border-[#b91c1c]/20 rounded-xl">
            <p className="text-sm font-medium text-[#b91c1c] mb-1">Need a new quote?</p>
            <p className="text-xs text-[#555] mb-3">Upload your files and get a custom price estimate.</p>
            <a
              href="/customquote.html"
              className="inline-block text-xs font-medium text-white bg-[#b91c1c] px-3 py-1.5 rounded-lg hover:bg-[#dc2626] transition-colors"
            >
              Get a Quote →
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, icon, accent }) {
  return (
    <div className={`rounded-xl p-5 border ${accent ? 'bg-[#b91c1c] border-[#b91c1c] text-white' : 'bg-white border-[#e0e0e0] text-[#111]'}`}>
      <div className="text-2xl mb-2">{icon}</div>
      <p className={`text-2xl font-bold ${accent ? 'text-white' : 'text-[#111]'}`}>{value}</p>
      <p className={`text-xs mt-0.5 ${accent ? 'text-white/80' : 'text-[#555]'}`}>{label}</p>
    </div>
  );
}

function QuickLink({ to, label, sub, icon }) {
  return (
    <Link
      to={to}
      className="flex items-center gap-3 p-4 bg-white border border-[#e0e0e0] rounded-xl hover:border-[#b91c1c]/40 hover:shadow-sm transition-all"
    >
      <span className="text-xl">{icon}</span>
      <div>
        <p className="text-sm font-medium text-[#111]">{label}</p>
        <p className="text-xs text-[#555]">{sub}</p>
      </div>
      <svg className="w-4 h-4 text-[#555] ml-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </Link>
  );
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}
