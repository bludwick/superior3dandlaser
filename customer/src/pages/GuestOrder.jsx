import { useNavigate } from 'react-router-dom';
import { useGuest } from '../hooks/useGuest';
import OrderDetail from '../components/OrderDetail';

export default function GuestOrder() {
  const { guestOrder, guestLogout } = useGuest();
  const navigate = useNavigate();

  function handleViewAnother() {
    guestLogout();
    navigate('/login', { state: { tab: 'guest' } });
  }

  if (!guestOrder) {
    return (
      <div className="min-h-screen bg-[#f1f1f1] flex items-center justify-center p-4">
        <div className="bg-white rounded-xl p-8 max-w-md w-full text-center shadow">
          <p className="text-[#555] mb-4">No order loaded. Please use Guest Access to look up your order.</p>
          <button
            onClick={() => navigate('/login')}
            className="px-4 py-2 bg-[#b91c1c] text-white text-sm rounded-lg hover:bg-[#dc2626]"
          >
            Back to Login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f1f1f1] py-8 px-4">
      <div className="max-w-3xl mx-auto">
        {/* Header bar */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm font-bold text-[#b91c1c]">Superior 3D and Laser</span>
            </div>
            <h1 className="text-xl font-bold text-[#111]">
              {guestOrder.projectName || 'Order Details'}
            </h1>
            <p className="text-sm text-[#555]">Project #{guestOrder.projectNumber || guestOrder.id}</p>
          </div>
          <button
            onClick={handleViewAnother}
            className="text-sm text-[#b91c1c] hover:underline"
          >
            View Another Order
          </button>
        </div>

        <div className="bg-white rounded-xl shadow border border-[#e0e0e0] p-6">
          <OrderDetail order={guestOrder} onClose={() => {}} />
        </div>

        <div className="mt-6 text-center">
          <p className="text-xs text-[#555]">
            Want to see all your orders in one place?{' '}
            <a href="mailto:sales@superior3dandlaser.com" className="text-[#b91c1c] hover:underline">
              Contact us
            </a>{' '}
            to set up an account.
          </p>
        </div>
      </div>
    </div>
  );
}
