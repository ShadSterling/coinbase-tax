import { spawnSync } from "child_process";
import { Console } from "console";
import * as moment from "moment";
import { sprintf } from "sprintf-js";

try {
	require('source-map-support').install()
	console.log( `Source map support loaded - stack traces should show actual source rather than compiled javascript` );
} catch(e) {
	console.log( `No source map support - stack traces will show compiled javascript rather than actual source (${e})` );
}

let accountInfo: string | undefined;
let walletId: string | undefined;

let exit_reason: any;

try {
	accountInfo = JSON.parse( process.argv[2] );
} catch(e) {
	exit_reason = e;
}

if( !accountInfo ) {
	console.log( `The first parameter must be a JSON string with Coinbase account credentials, e.g. \"{'apiKey': mykey, 'apiSecret': mysecret}\" (Error ${exit_reason}` );
	process.exit(2);
} else {

	let client = new (require('coinbase').Client)( accountInfo );

	walletId = process.argv[3];

	client.getAccounts( {}, (err:Error,accountList:any[]) => {
		if( err ) {
			console.log( "Failed to retrieve account information -- "+err.message );
			if( /UNABLE_TO_GET_ISSUER_CERT_LOCALLY|unable to get local issuer certificate/.test(err.message) ) {
				console.log( "This error can be bypassed by adding an override to your credentials: \"strictSSL\": false" );
			}
			process.exit(3);
		} else {
			console.log( "Connected to account..." );
			let accounts: any = {};
			for( let account of accountList ) {
				accounts[account.id] = account;
			}
			let account: any | undefined;
			try {
				account = accounts[walletId!];
			} catch(e) {
				exit_reason = e;
			}
			if( !account ) {
				console.log( `The second parameter must be a wallet ID in the Coinbase account (Error ${exit_reason}` );
				process.exit(4);
			}
			let transactions = [];
			let getTransactions = function( acct: any, all_txs: any[], callback: (all_txs:any[])=>void, pag = undefined ): void {
				let options = pag ? pag : { limit: 100, order: "asc" };
				console.log( `... Reading transactions with options ${JSON.stringify(options)}` );
				acct.getTransactions(
					options,
					( err:Error, txs:any[], pagination:any ) => {
						if( err ) {
							console.log( `!!! Error reading transactions: ${err}` );
							callback( all_txs );
						} else {
							console.log( `... Read ${txs.length} transactions` );
							if( txs.length == 0 ) {
								callback( all_txs );
							} else {
								all_txs.push( ...txs );
								if( pagination.next_uri ) {
									console.log( `... Recursing to read transactions after ${txs[txs.length-1].id} (because callback style doesn't allow iteration)` );
									getTransactions( acct, all_txs, callback, pagination );
								} else {
									console.log( `... Finished reading with ${txs[txs.length-1].id}` );
									callback( all_txs );
								}
							}
						}
					}
				);
			};
			console.log( "Reading transactions from wallet..." );
			getTransactions( account, [], (all_txs) => {
				console.log( `${all_txs.length} total transactions` );
				let ledger = new Ledger( account );
				// for( let tx of all_txs.sort( (a,b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime() ) ) {
				for( let rtx of all_txs ) {
					try {
						ledger.add( rtx );
					} catch(e) {
						console.log( `----- Exception: ${e.message}` );
						console.log( "Last Transaction:", ledger.last );
						console.log( "New Transaction:", rtx );
						throw e;
					}
				}
			} );
		}
	} );

}

class Ledger {

	private _wallet: any; // the wallet/"account" within a Coinbase account
	private _transactions: any[] = [];

	constructor( wallet: any ) {
		this._wallet = wallet;
		console.log( wallet.balance );
	}

	get last(): Transaction | undefined { return this._transactions[this._transactions.length-1]; }

	add( rtx: any ) {
		this._transactions.push( new Transaction( rtx, this._transactions[this._transactions.length-1] ) );
	}

}

class Transaction {

	id: string;
	time: number;
	amount: number;
	direction: "IN" | "OUT";
	type: "TRANSFER" | "TRADE" | "USE";
	exchange_amount: number;
	exchange_rate: number;
	prev: Transaction | undefined;
	balance: number;
	_acquired: Holdings = new Holdings();
	_held: Holdings = new Holdings();
	_divested: Holdings = new Holdings();
	long_term_cutoff: number | undefined;

	constructor( rtx: any, prev: Transaction | undefined ) {
		this.id = rtx.id;
		this.time = new Date( rtx.updated_at ).getTime() / 1000;
		this.amount = Math.abs(+rtx.amount.amount);
		this.prev = prev;
		switch( rtx.type ) {
			case "send": {
				this.type = "TRANSFER";
				if( rtx.to && rtx.from ) {
					throw `transfer has both 'from' and 'to' properties`;
				} else if( rtx.to ) {
					this.direction = "OUT"; // TODO: get real indicator of transfer vs use
					break;
				} else if( rtx.from ) {
					this.direction = "IN";
				} else {
					throw `transfer has neither 'from' nor 'to' properties`;
				}
				break;
			}
			case "buy": {
				this.type = "TRADE";
				this.direction = "IN";
				break;
			}
			case "sell": {
				this.type = "TRADE";
				this.direction = "OUT";
				break;
			}
			case "exchange_deposit": {
				this.type = "TRANSFER";
				this.direction = "OUT";
				break;
			}
			case "pro_deposit": {
				this.type = "TRANSFER";
				this.direction = "OUT";
				break;
			}
			default: {
				throw new Error( `Unimplemented transaction type: ${rtx.type}` );
				break;
			}
		}
		switch( this.direction ) {
			case "IN": {
				this.balance = prev ? prev.balance + this.amount : this.amount;
				switch( this.type ) {
					case "TRANSFER": {
						this.exchange_amount = 0; // TODO: get a real exchange amount
						this.exchange_rate = 0; // TODO: get a real exchange rate
						if( prev ) { this._held.add( ...prev.holdings ); }
						this._acquired.add( new Holding( this ) ); // TODO: allow acquisition date to preceed transfer to this account
						break;
					}
					case "TRADE": {
						this.exchange_amount = Math.abs( rtx.native_amount.amount );
						this.exchange_rate = this.exchange_amount / this.amount;
						if( prev ) { this._held.add( ...prev.holdings ); }
						this._acquired.add( new Holding( this ) );
						break;
					}
					default: { throw new Error( `Unhandled case: type = ${this.type}` ); break; }
				}
				break;
			}
			case "OUT": {
				if( prev ) {
					this.balance = prev.balance - this.amount;
				} else { // no previous transaction
					throw new Error( "Outgoing transaction must be preceeded by incoming transaction" );
				}
				const date = new Date( this.time * 1000 );
				const one_year_before: number = new Date( date.getFullYear()-1, date.getMonth(), date.getDate(), 0, 0, 0 ).getTime() / 1000;
				this.long_term_cutoff = new Date( (one_year_before - 86400) * 1000 ).getTime() / 1000; // the day before a year ago
				let sorted: Holding[];
				switch( this.type ) {
					case "TRANSFER": { // TODO: treat transfer fee as capital loss
						sorted = Array.from( prev.holdings ).sort( (a,b) => {
							if( a.acquisition_time < this.long_term_cutoff! && b.acquisition_time >= this.long_term_cutoff! ) { return +1; }
							if( b.acquisition_time < this.long_term_cutoff! && a.acquisition_time >= this.long_term_cutoff! ) { return -1; }
							const long = ( a.acquisition_time < this.long_term_cutoff! && b.acquisition_time < this.long_term_cutoff! );
							if( a.amount == this.amount && b.amount != this.amount ) { return -1; }
							if( b.amount == this.amount && a.amount != this.amount ) { return +1; }
							if( a.acquisition_rate > b.acquisition_rate ) { return +1; }
							if( b.acquisition_rate > a.acquisition_rate ) { return -1; }
							// if( a.amount >= this.amount && b.amount < this.amount ) { return -1; }
							// if( b.amount >= this.amount && a.amount < this.amount ) { return +1; }
							if( a.amount < b.amount ) { return -1; }
							if( b.amount < a.amount ) { return +1; }
							if( long ) {
								if( a.acquisition_time < b.acquisition_time ) { return -1; }
								if( b.acquisition_time < a.acquisition_time ) { return +1; }
							} else {
								if( a.acquisition_time > b.acquisition_time ) { return -1; }
								if( b.acquisition_time > a.acquisition_time ) { return +1; }
							}
							return 0;
						} );
						break;
					}
					case "TRADE": {
						this.exchange_amount = Math.abs(+rtx.native_amount.amount);
						this.exchange_rate = this.exchange_amount / this.amount;
						sorted = Array.from( prev.holdings ).sort( (a,b) => {
							if( a.acquisition_time < this.long_term_cutoff! && b.acquisition_time >= this.long_term_cutoff! ) { return -1; }
							if( b.acquisition_time < this.long_term_cutoff! && a.acquisition_time >= this.long_term_cutoff! ) { return +1; }
							const long = ( a.acquisition_time < this.long_term_cutoff! && b.acquisition_time < this.long_term_cutoff! );
							if( a.amount == this.amount && b.amount != this.amount ) { return -1; }
							if( b.amount == this.amount && a.amount != this.amount ) { return +1; }
							if( a.acquisition_rate > b.acquisition_rate ) { return -1; }
							if( b.acquisition_rate > a.acquisition_rate ) { return +1; }
							if( a.amount >= this.amount && b.amount < this.amount ) { return -1; }
							if( b.amount >= this.amount && a.amount < this.amount ) { return +1; }
							if( a.amount < b.amount ) { return -1; }
							if( b.amount < a.amount ) { return +1; }
							if( long ) {
								if( a.acquisition_time < b.acquisition_time ) { return -1; }
								if( b.acquisition_time < a.acquisition_time ) { return +1; }
							} else {
								if( a.acquisition_time > b.acquisition_time ) { return -1; }
								if( b.acquisition_time > a.acquisition_time ) { return +1; }
							}
							return 0;
						} );
						break;
					}
					default: { throw new Error( `Unhandled case: direction = ${this.type}` ); break; }
				}
				let uncovered = this.amount;
				let divest: Holding[] = [];
				let split: Holding | undefined;
				let price = 0;
				let holding: Holding | undefined;
				while( holding = sorted.shift() ) {
					if( holding.amount <= uncovered ) {
						// console.log( `... ${uncovered} => Divesting ${holding}` );
						divest.push( holding );
						price += holding.acquisition_price;
						uncovered -= holding.amount;
						if( uncovered <= 0 ) { break; };
					} else {
						split = holding;
						price += holding.acquisition_price * uncovered / holding.amount;
						break;
					}
				}
				if( !this.exchange_amount ) { this.exchange_amount = price; }
				if( !this.exchange_rate ) { this.exchange_rate = this.exchange_amount / this.amount; }
				for( holding of divest ) {
					holding.divest( this );
					this._divested.add( holding );
				}
				if( split ) {
					// console.log( `... ${uncovered} => Splitting ${holding}` );
					const [ split_cover, split_remaining ] = split.split( uncovered, this.time );
					// console.log( `... ${uncovered} => Holding ${split_remaining}` );
					this._held.add( split_remaining );
					// console.log( `... ${uncovered} => Divesting ${split_cover}` );
					split_cover.divest( this );
					this._divested.add( split_cover );
					uncovered -= split_cover.amount;
					if( uncovered > 0 ) { throw new Error( "transaction not covered" ); }
				}
				// console.log( `... ${uncovered} => Holding ${sorted.length}` );
				this._held.add( ...sorted );
				break;
			}
			default: { throw new Error( `Unhandled case: direction = ${this.direction}` ); break; }
		}
		console.log(
			sprintf(
				` ---------- ${this.timeString}${prev && this.time < prev.time ? " ** DELAYED" : ""} -- ${this.id}: %11.8f <= %3s/%-8s %11.8f @ %12.6f = %9.2f => +++ %11.8f === %11.8f --- %11.8f`,
				this.balance,
				this.direction,
				this.type,
				this.amount,
				this.exchange_rate,
				this.exchange_amount,
				this._acquired,
				this._held,
				this._divested,
			)
		);
		// if( this._acquired.count > 0 ) {
		// 	for( const holding of this._acquired ) {
		// 		console.log( `ACQUIRED ${holding}` );
		// 	}
		// }
		// if( this._held.count > 0 ) {
		// 	let remaining = this._held.count;
		// 	let stop = this._held.count - 3;
		// 	for( const holding of this._held ) {
		// 		console.log( `HOLDING ${holding}` );
		// 		remaining -= 1;
		// 		if( remaining <= stop ) { break; }
		// 	}
		// 	if( remaining > 0 ) {
		// 		console.log( `HOLDING ... ${remaining} more previous acquisitions` );
		// 	}
		// }
		if( this._divested.count > 0 ) {
			for( const holding of this._divested ) {
				console.log( `CAPITAL GAINS from ${holding}` );
			}
			// throw "debug";
		}
		this._acquired.validate();
		this._held.validate();
		const balance = this._acquired.amount + this._held.amount;
		const error = Math.abs( this.balance - balance );
		if( error > 0.00000000000001 ) { throw new Error( `Balance mismatch: ${this.balance} ≠ ${balance}` ); }
	}

	get timeString() { return moment(this.time*1000).format("YYYY-MM[]MMM-DDddd HH:mm:ss Z").replace("-05:00","EST").replace("-04:00","EDT"); }
	get holdings() { return this.holdings_iterator(); }
	*holdings_iterator() { yield* this._acquired; yield* this._held; }
}

class Holdings {
	private _holdings: Set<Holding> = new Set();
	private _total: number = 0;
	get count() { return this._holdings.size; }
	get amount() { return this._total; }
	public add( ...holdings: Holding[] ) {
		for( const holding of holdings ) {
			this._holdings.add( holding );
			this._total += holding.amount;
		}
	}
	public validate(): void {
		let amount = 0;
		for( const holding of this._holdings ) { amount += holding.amount; }
		if( amount != this._total ) { throw new Error( `Validation failed: incorrect total, ${this._total} ≠ ${amount}` ); }
	}
	public *[Symbol.iterator]() {
		for( const holding of this._holdings ) {
			yield holding;
		}
    }
	toString(): string { return `${this._total}`; }
}

class Holding {
	public readonly amount: number;
	public readonly acquisition_time: number;
	public readonly acquisition_price: number;
	public readonly acquisition_rate: number;
	public readonly acquisition_tx: Transaction | undefined;
	public readonly acquisition_split: Holding | undefined;
	private _divestment_time: number | undefined;
	private _divestment_price: number | undefined;
	private _divestment_rate: number | undefined;
	private _divestment_tx: Transaction | undefined;
	private _divestment_split: Set<Holding> | undefined;
	constructor(
		source: Transaction | Holding,
		split: number = source.amount,
	) {
		this.amount = split;
		if( source instanceof Transaction ) {
			this.acquisition_time = source.time;
			this.acquisition_rate = source.exchange_rate;
			this.acquisition_tx = source;
		} else if( source instanceof Holding ) {
			this.acquisition_time = source.acquisition_time;
			this.acquisition_rate = source.acquisition_rate;
			this.acquisition_split = source;
		}
		this.acquisition_price = this.acquisition_rate == 0 ? 0 : this.amount * this.acquisition_rate;
		// console.log( `! ! ! ! ${this.amount} * ${this.acquisition_rate} = ${this.acquisition_price}`);
	}
	divest( tx: Transaction ) {
		if( this._divestment_tx || this._divestment_split ) {
			throw new Error( "Holding can only be divested once" );
		} else {
			this._divestment_tx = tx;
			this._divestment_time = tx.time;
			this._divestment_price = this.amount * tx.exchange_rate;
			this._divestment_rate = tx.exchange_rate;
		}
		return this;
	}
	split( amount: number, time: number ): [ Holding, Holding ] {
		if( amount > this.amount ) { throw new Error( "Holding cannot be split into larger amount" ); }
		const parts: [ Holding, Holding ] = [
			new Holding( this, amount ),
			new Holding( this, this.amount - amount ),
		]
		this._divestment_split = new Set( parts );
		this._divestment_time = time;
		this._divestment_price = this.acquisition_price;
		this._divestment_rate = this.acquisition_rate;
		return parts;
	}
	get divestment_time(): number | undefined { return this._divestment_time; }
	get divestment_price(): number | undefined { return this._divestment_price; }
	get divestment_rate(): number | undefined { return this._divestment_rate; }
	get divestment_split(): Set<Holding> | undefined { return this._divestment_split; }
	get timeAcquired() { return moment(this.acquisition_time*1000).format("YYYY-MM[]MMM-DDddd HH:mm:ss Z").replace("-05:00","EST").replace("-04:00","EDT"); }
	get timeDivested() { return this._divestment_time ? moment(this._divestment_time*1000).format("YYYY-MM[]MMM-DDddd HH:mm:ss Z").replace("-05:00","EST").replace("-04:00","EDT") : undefined; }
	get duration() { return  this._divestment_time ? this._divestment_time - this.acquisition_time : undefined; }
	get gain() { return (typeof this._divestment_price == "number") ? this._divestment_price - this.acquisition_price : undefined; }
	toString() {
		if( this._divestment_tx ) {
			return sprintf( `Amount %11.8f; Acquired At ${this.timeAcquired}, Divested At ${this.timeDivested}, Held for %10.6f days; Divested @ %12.6f for %9.2f, Acquired @ %12.6f for %9.2f; Capital Gain %8.2f`, this.amount, this.duration!/86400, this._divestment_rate, this.divestment_price, this.acquisition_rate, this.acquisition_price, this.gain );
		} else if( this._divestment_split ) {
			return sprintf( `Amount %11.8f; Acquired At ${this.timeAcquired}, Split At ${this.timeDivested}, Held for %10.6f days`, this.amount, this.duration!/86400 );
		} else {
			return sprintf( `Amount %11.8f; Acquired At ${this.timeAcquired}`, this.amount );
		}
	}
}
