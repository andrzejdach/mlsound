var common = require('../../lib/common.js');
var fs = require('fs');
var keys = Object.keys || require('object-keys');
var marklogic = require('marklogic');
var mlutil = require('marklogic/lib/mlutil.js');
var recursive = require('recursive-readdir');
var util = require('../../lib/utils.js');
var logger = util.consoleLogger;

var DBManager = module.exports;

DBManager.databaseOperation = function(operation, database, callback) {
    var manager = this.getHttpManager();
    //Issue command
    manager.post({
        endpoint: '/manage/v2/databases/' + database,
        body: { 'operation' : operation }
    }).
    result(function(response) {
        if (response.statusCode === 200) {
            if(callback) {
                callback();
            }
        }
        else {
            logger.error('Error when issuing database operation %s at %s [Error %s]',
                operation, database, response.statusCode);
            logger.error(response.data);
            process.exit(1);
        }
    });
};

DBManager.buildForestsByHost = function(dbSettings, callback) {

    // from http://stackoverflow.com/questions/1267283/how-can-i-create-a-zerofilled-value-using-javascript
    function pad(number, padding, character) {
        var pad_char = typeof character !== 'undefined' ? character : '0';
        var buffer = new Array(1 + padding).join(pad_char);
        return (buffer + number).slice(-buffer.length);
    }

    var count = dbSettings.forest['forests-per-host'];
    // idenfity the hosts
    var hosts = this.getConfiguration('hosts');
    // build forest names
    var forests = [], forestNames = [];
    hosts.forEach(function(host, index) {
        var hostSettings = common.objectSettings('hosts/' + host, this.env);
        console.log('host is: ' + hostSettings['host-name']);
        for (var i = 0; i < count; i++) {
            forests.push({
                'host': hostSettings['host-name'],
                'forest-name': dbSettings['database-name'] + '-' + pad(index, 3) + '-' + pad(i, 3)
            });
        }
    });

    var outStandingRequests = forests.length;
    var checkFinished = function() {
        if (outStandingRequests === 0 && callback) {
            callback(forestNames);
        }
    };

    var manager = this.getHttpManager();
    forests.forEach(function(forest) {
        forestNames.push(forest['forest-name']);
        manager.get({
            endpoint: '/manage/v2/forests/' + forest['forest-name']
        })
        .result(function(response) {
            if (response.statusCode === 404) {
                console.log('creating forest ' + forest['forest-name']);
                manager.post({
                    endpoint : '/manage/v2/forests',
                    body : forest
                })
                .result(function(response) {
                    if (response.statusCode === 201) {
                        // yay. We're done with this one.
                        --outStandingRequests;
                        checkFinished();
                    } else {
                        logger.error('Error when creating %s [Error %s]', forest, response.statusCode);
                        console.error(response.data);
                        process.exit(1);
                    }
               });
            } else if (response.statusCode === 200) {
                // Already exists, no need to create
                --outStandingRequests;
                checkFinished();
            } else {
                logger.error('Error when checking %s [Error %s]', forest, response.statusCode);
                console.error(response.data);
                process.exit(1);
            }
        });
    });
};

DBManager.buildDatabase = function(settings, type, callback) {
    var BASE_SERVER_URL = '/manage/v2/databases';
    var UPDATE_SERVER_URL = BASE_SERVER_URL + '/' + settings['database-name'];
    var manager = this.getHttpManager();
    //Check if server exists
    manager.get({
        endpoint: UPDATE_SERVER_URL
    }).
    result(function(response) {
        if (response.statusCode === 404) {
            //database not found
            //let's create it
            logger.info('Creating ' + type +  ' database');
            manager.post(
                {
                    endpoint : BASE_SERVER_URL,
                    body : settings
                }).result(function(response) {
                        if (response.statusCode === 201) {
                            logger.info(type + ' database created');
                        } else {
                            logger.error('Error when creating %s database [Error %s]', type, response.statusCode);
                            logger.error(response.data.errorResponse.message);
                            logger.debug('Database settings: ' + JSON.stringify(settings));
                            process.exit(1);
                        }

                        if (callback) {
                            callback();
                        }
                });
        } else if (response.statusCode === 200) {
            manager.put(
                {
                    endpoint : UPDATE_SERVER_URL + '/properties',
                    body : settings
                }).result(function(response) {
                        if (response.statusCode !== 204) {
                            logger.error('Error when updating %s database [Error %s]', type, response.statusCode);
                            logger.error(response.data);
                            process.exit(1);
                        }

                        if (callback) {
                            callback();
                        }
                });
        } else {
            logger.error('Error when checking %s database [Error %s]', type, response.statusCode);
            logger.error(response.data);
            process.exit(1);
        }

    });
};

DBManager.initializeDatabase = function(type, callback) {
    var that = this;
    var settings = common.objectSettings('databases/' + type, this.env);

    if (!Array.isArray(settings.forest)) {
        // settings.forest may be an object that contains a forests-per-host value.
        this.buildForestsByHost(settings, function(forestNames) {
            settings.forest = forestNames;
            that.buildDatabase(settings, type, callback);
        });
    } else {
        that.buildDatabase(settings, type, callback);
    }

};

DBManager.removeDatabase = function(type, removeForest, callback) {
    //check removeForest value
    if (removeForest && !/(configuration|data)/i.test(removeForest)) {
        logger.error('Only configuration and data allowed for removeForest parameter');
        process.exit(1);
    }
    var settings = common.objectSettings('databases/' + type, this.env);
    var SERVER_URL = '/manage/v2/databases/' + settings['database-name'];
    var manager = this.getHttpManager();
    //Check if server exists
    manager.get({
        endpoint: SERVER_URL
    }).
    result(function(response) {
        if (response.statusCode === 200) {
            manager.remove(
                {
                    endpoint : SERVER_URL,
                    params : (removeForest ? { 'forest-delete' : removeForest } : undefined)
                }).result(function(response) {
                        if (response.statusCode !== 204) {
                            logger.error('Error when deleting %s database [Error %s]', type, response.statusCode);
                            logger.error(response.data);
                            process.exit(1);
                        }

                        if (callback) {
                            callback();
                        }
                });
        } else if (response.statusCode === 404) {
            //database already removed
            if (callback) {
                callback();
            }
        } else {
            logger.error('Error when deleting %s database [Error %s]', type, response.statusCode);
            logger.error(response.data);
            process.exit(1);
        }

    });
};

DBManager.loadDocuments = function(folder, database, callback) {

    var settings = mlutil.copyProperties(this.settings.connection);
    //Need to connect to Rest API, not management one
    settings.port = this.httpSettings.port;
    settings.database = database;
    var db = marklogic.createDatabaseClient(settings);

    recursive(folder, function (err, files) {
        var callBackwhenDone = (function() { var total = files.length;
            return function() {
                total = total-1;
                if (total < 1) {
                    callback();
                }
            };
        })();

        if (err) {
            logger.error(folder + ' Folder not found');
            process.exit(1);
        }
        files.forEach(function(file){
            var document = fs.readFileSync(file, 'utf8');
            db.documents.write(
              {
                uri: file.replace(new RegExp('^'+folder),''),
                content: document
              }
            ).result(
                function(response) {
                    callBackwhenDone();
                },
                function(error) {
                    logger.error('Error loading file ' + file);
                    logger.error(error);
                    process.exit(1);
                }
            );
        });
    });
};
