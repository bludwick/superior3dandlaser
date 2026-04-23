import Orders from './Orders';

export default function Quotes({ orders }) {
  const quotes = orders.filter(o => o.source === 'quote' || o.status === 'Quote Request');
  return <Orders orders={quotes} title="Quotes" />;
}
