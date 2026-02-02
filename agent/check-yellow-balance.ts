import WebSocket from 'ws';
import * as dotenv from 'dotenv';

dotenv.config();

const ws = new WebSocket('wss://clearnet-sandbox.yellow.com/ws');

ws.on('open', () => {
  console.log('Connected to Yellow Network');
  
  // Send a balance query or account info request
  const balanceQuery = {
    req: 'getBalances',
    id: Date.now()
  };
  
  ws.send(JSON.stringify(balanceQuery));
  console.log('Sent balance query');
});

ws.on('message', (data) => {
  const message = JSON.parse(data.toString());
  console.log('\n📨 Message:', JSON.stringify(message, null, 2));
  
  if (message.res && Array.isArray(message.res) && message.res[0] === 'getBalances') {
    console.log('\n💰 Yellow Network Balances:', message.res[1]);
    ws.close();
  }
});

ws.on('error', (error) => {
  console.error('Error:', error.message);
});

setTimeout(() => {
  console.log('\n⏱️ Timeout - closing connection');
  ws.close();
  process.exit(0);
}, 5000);
