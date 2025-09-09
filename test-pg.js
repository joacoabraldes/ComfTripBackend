const dns = require('dns');
const net = require('net');
const host = 'db.zcpdiaszgdagixmceedz.supabase.co';

dns.resolve4(host, (e4, a4) => console.log('resolve4 ->', e4 ? e4.message : a4));
dns.resolve6(host, (e6, a6) => console.log('resolve6 ->', e6 ? e6.message : a6));
const s = new net.Socket();
s.setTimeout(5000);
s.on('connect', () => { console.log('TCP OK'); s.destroy(); });
s.on('timeout', () => { console.log('TCP timeout'); s.destroy(); });
s.on('error', e => console.log('TCP error ->', e.message));
s.connect(5432, host);