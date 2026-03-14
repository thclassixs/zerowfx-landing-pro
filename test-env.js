import 'dotenv/config';
console.log('=== TEST ENV ===');
console.log('NEWSDATA:', !!process.env.NEWSDATA_API_KEY);
console.log('FINNHUB:', !!process.env.FINNHUB_API_KEY);
console.log('CLAUDE:', !!process.env.ANTHROPIC_API_KEY);
console.log('PORT:', process.env.PORT);
