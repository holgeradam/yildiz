"use strict";

const Promise = require("bluebird");
const fastify = require("fastify");
const debug = require("debug")("yildiz:http:server");
const cors = require("cors");
const log4bro = require("log4bro");
const path = require("path");
const fs = require("fs");

const pjson = require("./../../package.json");
const SERVER_NAME = `yildiz-http:${pjson.version}`;

const {
    YildizFactory
} = require("./../YildizFactory.js");
const Translator = require("./../graph/Translator.js");
const Metrics = require("./Metrics.js");

const {
    admin,
    root,
    translator,
    node,
    edge,
    access,
    raw,
    path: pathRouter
} = require("./routes");

const SWAGGER_FILE = "../../docs/swagger.json";
let CREATE_SWAGGER = false;
if(process.env.CREATE_SWAGGER){
    CREATE_SWAGGER = true;
}

const prefixRegex = /^\w+$/;

class Server {

    constructor(port = 3058, options = {}) {

        this.port = port;

        let {
            accessLog,
            enableRaw
        } = options;

        this.accessLog = typeof accessLog === "boolean" ? accessLog : false;
        this.enableRaw = typeof enableRaw === "boolean" ? enableRaw : false;

        this.app = fastify();
        this.factory = new YildizFactory(options);
        this.translator = new Translator(null);
        this.metrics = new Metrics(this);
        this.stats = {
            http: {}
        };

        this._init();
    }

    _init() {

        debug("initialising http server routes..");

        this.app.decorate("factory", this.factory);
        this.app.decorate("translator", this.translator);
        this.app.decorate("metrics", this.metrics);

        this.app.decorate("getStats", () => {
            return this.getStats();
        });

        this.app.decorate("incStat", key => {
            return this.incStat(key);
        });

        this.app.use((req, res, next) => {
            this.incStat("request");
            res.setHeader("powered-by", SERVER_NAME);
            next();
        });

        if(this.accessLog){

            const logger = new log4bro({
                productionMode: true,
                silence: false,
                dockerMode: true,
                varKey: "L4B",
                serviceName: "yildiz-http"
            });

            logger.applyMiddlewareAccessLog(this.app);
        }

        const registerErrorHandler = error => {
            if(error){
                throw error;
            }
        }
        
        this.app.use(cors());

        if(CREATE_SWAGGER){
            debug("creating swagger file.");
            this.app.register(require("fastify-swagger"), {
                swagger: {
                    info: {
                        title: "yildiz HTTP interface",
                        description: "Graph Database on top of MySQL",
                        version: pjson.version
                    },
                    host: "localhost",
                    schemes: ["http"],
                    consumes: ["application/json"],
                    produces: ["application/json"]
                }
            });
        }

        this.app.register(root, {
            prefix: "/"
        }, registerErrorHandler);

        this.app.register(admin, {
            prefix: "/admin"
        }, registerErrorHandler);

        //ensure prefix header safety
        this.app.use((req, res, next) => {

            if(req.url === "/" || req.url.startsWith("/admin")){
                return next(); //skip on default paths
            }
            
            if(!req.headers["x-yildiz-prefix"]){
                this.incStat("missing_prefix");
                res.statusCode = 400;
                return res.end(JSON.stringify({
                    error: "missing 'x-yildiz-prefix' header"
                }));
            }

            if(!prefixRegex.test(req.headers["x-yildiz-prefix"])){
                this.incStat("bad_prefix");
                res.statusCode = 400;
                return res.end(JSON.stringify({
                    error: "Prefix header is not accepted, check on this regex: ^\w+$"
                }));
            }
            
            next();
        });

        this.app.register(translator, {
            prefix: "/translator"
        }, registerErrorHandler);

        this.app.register(pathRouter, {
            prefix: "/path"
        }, registerErrorHandler);

        this.app.register(node, {
            prefix: "/node"
        }, registerErrorHandler);

        this.app.register(edge, {
            prefix: "/edge"
        }, registerErrorHandler);

        this.app.register(access, {
            prefix: "/access"
        }, registerErrorHandler);

        if(this.enableRaw){
            debug("raw access enabled!");
            this.app.register(raw, {
                prefix: "/raw"
            }, registerErrorHandler);
        } else {
            debug("raw access disabled.");
        }

        this.app.ready(error => {
            
            if(error){
                throw error;
            }

            if(typeof this.app.swagger === "function"){
                const filePath = path.join(__dirname, SWAGGER_FILE);
                fs.writeFile(filePath, JSON.stringify(this.app.swagger()), error => {

                    if(error){
                        throw error;
                    }

                    debug("wrote swagger file.");
                });
            }
        });

        debug("initialising http server routes... done.");
    }

    incStat(key){
        //int
        if(!this.stats.http[key]){
            this.stats.http[key] = 1;
        } else {
            this.stats.http[key] += 1;
        }
    }

    async getStats(){
        const stats = Object.assign({}, this.stats, {
            factory: await this.factory.getStats()
        });
        return stats;
    }

    listen() {
        return new Promise((resolve, reject) => {
            this.app.listen(this.port, error => {

                if (error) {
                    return reject(error);
                }

                debug("server listening on port", this.port);
                this.metrics.run();
                resolve(this.port);
            });
        });
    }

    close(){

       if(this.metrics){
           this.metrics.close();
       }

        return new Promise(resolve => {
            this.app.close(resolve);
        });
    }
}

module.exports = {
    Server
};