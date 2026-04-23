import { createContext, useContext, useState, useEffect } from 'react';
import { api } from '../utils/api';

const GuestContext = createContext(null);

export function GuestProvider({ children }) {
  const [guestOrder, setGuestOrder] = useState(() => {
    const stored = sessionStorage.getItem('guest_data');
    return stored ? JSON.parse(stored) : null;
  });

  async function guestLogin(projectNumber, email) {
    const data = await api.post('/api/customer/guest', { projectNumber, email });
    sessionStorage.setItem('guest_data',  JSON.stringify(data.order));
    sessionStorage.setItem('guest_token', data.token);
    setGuestOrder(data.order);
    return data.order;
  }

  function guestLogout() {
    sessionStorage.removeItem('guest_data');
    sessionStorage.removeItem('guest_token');
    setGuestOrder(null);
  }

  return (
    <GuestContext.Provider value={{ guestOrder, guestLogin, guestLogout }}>
      {children}
    </GuestContext.Provider>
  );
}

export function useGuest() {
  return useContext(GuestContext);
}
