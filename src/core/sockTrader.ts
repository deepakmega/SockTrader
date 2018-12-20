import process, {ChildProcess} from "child_process";
import uniqBy from "lodash.uniqby";
import uniqWith from "lodash.uniqwith";
import {ICandleInterval} from "./candleCollection";
import {IExchange} from "./exchanges/exchangeInterface";
import BaseStrategy, {IStrategyClass} from "./strategy/baseStrategy";

interface IStrategyConfig {
    exchange: IExchange;
    interval: ICandleInterval;
    pair: string;
    strategy: IStrategyClass<BaseStrategy>;
}

interface ISockTraderConfig {
    webServer: boolean;
}

/**
 * @class SockTrader
 * @classdesc Main class to start trading with SockTrader
 */
export default class SockTrader {
    private exchanges: IExchange[] = [];
    private strategyConfigurations: IStrategyConfig[] = [];
    private webServer: ChildProcess | undefined;

    constructor(private config: ISockTraderConfig = {webServer: true}) {
        if (this.config.webServer) {
            this.webServer = process.fork(`${__dirname}/webServer.js`, [], {
                stdio: ["ipc"],
            });
            this.webServer.on("message", msg => {
                console.log("msg received", msg);
            });
        }
    }

    addExchange(exchange: IExchange): this {
        this.exchanges.push(exchange);

        return this;
    }

    addStrategy(config: IStrategyConfig): this {
        this.strategyConfigurations.push(config);

        return this;
    }

    isWebServerReady(): Promise<boolean> {
        return new Promise((resolve, reject) => {
            // @TODO!!
            // if (this.webServer === undefined) return resolve(true);
            // this.webServer.once("ready", () => resolve(true));
            // this.webServer.once("exit", () => reject(false));
        });
    }

    async start(): Promise<void> {
        const ready = await this.isWebServerReady();
        console.log("READDDYYYY", ready);

        if (this.strategyConfigurations.length < 1 || this.exchanges.length < 1) {
            throw new Error("SockTrader should have at least 1 strategy and at least 1 exchange.");
        }

        this.exchanges.forEach(exchange => {
            const config = this.strategyConfigurations.filter(str => str.exchange === exchange);
            if (config.length <= 0) {
                return; // No strategyConfigurations found for exchange
            }

            const strategies = config.map(c => new c.strategy(c.pair, c.exchange));
            this.bindStrategiesToExchange(exchange, strategies);
            this.bindExchangeToStrategies(exchange, strategies);
            this.subscribeToExchangeEvents(exchange, strategies, config);
            exchange.connect();
        });
    }

    subscribeToExchangeEvents(exchange: IExchange, strategies: BaseStrategy[], config: IStrategyConfig[]): void {
        exchange.once("ready", () => exchange.subscribeReports());

        // Be sure to only subscribe once to a certain trading pair.
        // Even if multiple strategyConfigurations are listening to the same events.
        // Because we will dispatch the same data to each strategy.
        uniqBy(strategies, "pair")
            .map(({pair}) => exchange.once("ready", () => exchange.subscribeOrderbook(pair)));

        uniqWith(config, (arr, oth) => arr.pair === oth.pair && arr.interval === oth.interval)
            .map(({pair, interval}) => exchange.once("ready", () => exchange.subscribeCandles(pair, interval)));
    }

    private bindExchangeToStrategies(exchange: IExchange, strategies: BaseStrategy[]): void {
        exchange.on("app.report", report => strategies.forEach(strategy => strategy.notifyOrder(report)));
        exchange.on("app.updateOrderbook", orderbook => strategies.forEach(strategy => strategy.updateOrderbook(orderbook)));
        exchange.on("app.updateCandles", candles => strategies.forEach(strategy => strategy.updateCandles(candles)));
    }

    private bindStrategiesToExchange(exchange: IExchange, strategies: BaseStrategy[]): void {
        strategies.forEach(strategy => {
            strategy.on("app.signal", ({symbol, price, qty, side}) => exchange[side](symbol, price, qty));
            strategy.on("app.adjustOrder", ({order, price, qty}) => exchange.adjustOrder(order, price, qty));
        });
    }
}
