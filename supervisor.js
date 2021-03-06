/**
 * mPlane supervisor example
 *
 * @author fabrizio.invernizzi@telecomitalia.it
 *  	    Capability push, Specification pull paradigm ONLY
 *
 *	  02_2015	Netvisor GUI extensions integrated
 *    02_2015 	Status persistency with node-persist
 *  2102_2015 	Keeps track of Specification checks from DN. If not seen in main.capabilityLostPeriod, they are deleted 
 *  2502_2015	Gracefull shutdown with ^C: it dumps relevant info and then shuts down
 *  0603_2015   GUI and Supervisor app listen on different ports 
 *  2805_2015	Supervisor now respect the when in showSpecification
 *
 *
 */

// PM2 route analytics
 var pmx = require('pmx').init();

var mplane = require('mplane'),
    express = require('express'),
    morgan  = require('morgan'),
    app = express(),
    gui_app = express(),
    inquirer = require("inquirer"),
    _ = require("lodash"),
    prettyjson = require('prettyjson'),
    bodyParser = require('body-parser'),
    https = require('https'),
    http = require('http')
    supervisor = require("mplane_http_transport"),
    fs = require('fs'),
    ssl_files = require("./ssl_files")
	,session = require('express-session')
	,cli = require("cli").enable('status')
	,serialize = require('node-serialize')
	,events = require('events')
	,fs = require('fs-extra')
	,basicAuth = require('basic-auth-connect');

// Load users details
var users = require("./users.js");

// This is done to have a persistency in critical information
var eventEmitter = new events.EventEmitter();

var CONFIGFILE = "supervisor.json"; //TODO:This should be overwrittable by cli

//-----------------------------------------------------------------------------------------------------------
// READ CONFIG
var configuration;
try {
    configuration = JSON.parse(fs.readFileSync(CONFIGFILE));
}
catch (err) {
    console.log('There has been an error parsing the configuration file.')
    console.log(err);
    process.exit();
}
//-----------------------------------------------------------------------------------------------------------

var ssl_options = {
    key: ssl_files.readFileContent(configuration.ssl.key)
    ,cert: ssl_files.readFileContent(configuration.ssl.cert)
    ,ca: ssl_files.readCaChain(configuration.ssl.ca)
    ,requestCert: configuration.ssl.requestCert
    ,rejectUnauthorized: false // So we can decide in the app!
};

// Internal specification status
var __SPEC_STATUS_QUEUED_="queued";
var __SPEC_STATUS_PROBE_TAKEN_="taken";
var __SPEC_STATUS_RESULT_READY_="result_ready";

// Process name for ps
process.title = "mPlane supervisor";

// PM2 soft reload
process.on("message", function(message) {
    if(message == "shutdown") {
        dumpStatus(function(){
			console.log("\nNothing more to do here, BYE!");
			process.exit();
		});
    }
});

// Gracefull shutdown
process.on('SIGINT', function() {
	dumpStatus(function(){
		console.log("\nNothing more to do here, BYE!");
		process.exit();
	});
});

/***************************
 *
 * Global DATA STRUCTURES
 *
 ************************/

// List of capabilities registered to this supervisor
// Each element is identified by its unique DN and each capability by its token
var __registered_capabilities__ = {};
// List of required measures, indexed by probe token
// Capability push, Specification pull paradigm
var __required_specifications__ = {};
// Index of receipt tokens with link to registered capabilities
// The keys are the receipt tokens, and each obj contains cohordinates for accessing the specification in __required_specifications__
// example {"38be4396e4e3691157b65425727dba9e092e0fc8":{dn:... , label:... , specificationToken:...}}
var __sent_receipts__ = {};

// Result obtained by probes
var __results__ = {};
// List of all DN that have done at least a register capability
var __registered_DN__= [];

// In order to drop lost DNs, we remember the last time we have seen a Specification pull 
var __last_seen_DNs__ = {}


/***************************/

// Load the reference registry
mplane.Element.initialize_registry(configuration.registry.url);

//console.log(mplane.Element.get_registry());

//----------------------------------------------------
// DATA persistency. Dump can be triggered by DBChangedEvent
// Load data on reload if enabled
restoreStatus();
// On change on critical elements, dump them
var manage_db_change = function(){
	dumpStatus(function(){if (configuration.dumpStatus.enabled) cli.debug("DB changed!")});
}

eventEmitter.on('DBChangedEvent', manage_db_change );

//----------------------------------------------------

// Check for dead DN 
var recheck = setInterval(function(){
   removeDeadCapabilities();
} , 5000);


/*********************
*	HTTP server
*********************/
// Log all requests to file
app.use(morgan("combined" ,{ "stream":fs.createWriteStream(configuration.main.logFile)}));
gui_app.use(morgan("combined" ,{ "stream":fs.createWriteStream(configuration.main.logFile)}));

// BASIC AUTH
gui_app.use(basicAuth(function(user, pass) {
	var auth = false;
	if (users[user]){
		if (users[user].password == pass){
			auth = true;
		}
	}
	return auth;
}));

var httpsServer = https.createServer(ssl_options, app);
var httpsGuiServer = https.createServer(ssl_options, gui_app);

httpsServer.on("clientError" , function(exception, securePair){
	cli.debug("--- clientError ---");
});

httpsServer.listen(configuration.main.listenPort , configuration.main.hostName);
httpsGuiServer.listen(configuration.main.webGuiPort , configuration.main.hostName);


// Static contents
gui_app.use(supervisor.GUI_STATIC_PATH, express.static(__dirname + configuration.gui.staticContentDir));

//FIXME: this should be dynamic!
gui_app.use("/gui" , session({
  name:"user",
  secret: 'mplane',
  resave: false,
  saveUninitialized : false
}));

gui_app.use(supervisor.GUI_STATIC_PATH,function(req, res, next){
		// Is the client claiming a valid certificate?
    	if (req.client.authorized){
    	    next();
    	}else{
    	   res.writeHead("403", {
    	        'Error': "Invalid certificate or no certificate provided"
    	   });
    	    res.end("Invalid certificate or certificate not provided");
    	}
});


// parse application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({ extended: true }));
// parse application/json
app.use(bodyParser.json());

// Default parse content as json
app.use(bodyParser.json({type:"application/*"}));

// Error handling
app.use(function (error, req, res, next) {
  if (!error) {
    next();
  } else {
    console.error(error.stack);
    res.sendStatus(500);
  }
});

// parse application/x-www-form-urlencoded
gui_app.use(bodyParser.urlencoded({ extended: true }));
// parse application/json
gui_app.use(bodyParser.json());

// Default parse content as json
gui_app.use(bodyParser.json({type:"application/*"}));

// Error handling
gui_app.use(function (error, req, res, next) {
  if (!error) {
    next();
  } else {
    console.error(error.stack);
    res.sendStatus(500);
  }
});

/***********************************************************************************/
//
// 			--- GUI specific route ---
//
/***********************************************************************************/

gui_app.post(supervisor.GUI_LOGIN_PATH ,function(req , res){
		//TODO: implement user authentication!
		res.cookie('user', 'mPlane');
		res.send(JSON.stringify({}));
});
// Here the gui asks for knowing if authenticated.
gui_app.get(supervisor.GUI_USERSETTINGS_PATH,function(req , res){
	res.send(JSON.stringify({}));
});

/***********************************************************************************
*
*	HTTP API
*
***********************************************************************************/
/**
 * We have received a POST message with a register for a capability
 * The data structrure is : [DN][token] where token can be the capability token or the label
 */
app.post(supervisor.SUPERVISOR_PATH_REGISTER_CAPABILITY, function(req, res){
	registerDN(DN(req));
    
	updateLasteSeen(DN(req));
	
    var newCapability
        ,port = configuration.main.listenPort
        ,proto="https";
    // We receive a Json containing multiple capability
    var received = req.body;
    var ret = {}; // Return array
    _.each(received.contents , function(cap){
        newCapability = mplane.from_dict(cap);
        // Check if we received a capability.
        if (!(newCapability instanceof mplane.Capability)){
            // Bad Request
            var tmp= {};
            ret[newCapability.get_label()] =  {registered:"no",reason: "mPlane Error : not a Capability/wrong format"};
	    cli.debug("mPlane Error : not a Capability/wrong format from "+DN(req));
        }else{ // OK
            var tmp= {};
            ret[newCapability.get_label()] =  {registered:"ok"};
            // First check if already registered, then register
            var registered = capabilityAlreadyRegistered(newCapability , DN(req)),
                newToken = registerCapability(newCapability , DN(req));
	     cli.debug("New CAPABILITY ("+newCapability.get_label()+") from "+ DN(req));
        }
    });
    res.send(JSON.stringify(ret));
});

/**
 * Someone sending a SPECIFICATION
 * We expect the json form:{DistinguishedName:{specification}}. This allows for send specification for a different DN from sender (es a client registering a specification for a probe)
 *
 */
app.post(supervisor.SUPERVISOR_PATH_REGISTER_SPECIFICATION  , function(req, res){	
	registerSpecification(req , res);
});

gui_app.post( supervisor.GUI_RUNCAPABILITY_PATH, function(req, res){
	registerSpecification(req , res);
});


// For show
app.param('itemType', function(req,res, next, itemType){
    req.itemType = itemType;
    next();
});
app.param('itemHash', function(req,res, next, itemHash){
    req.itemHash = itemHash;
    next();
});
/*
 A probe query for available specifications
 */
var tokenReq = null;
app.param('token', function(req,res, next, token){
    tokenReq = null;
    var t = token.split("=");
    if (t[1])
        tokenReq = t[1];
    next();
});
/**
 * Someone is asking for specification(s)
 * We recognize the requester by its DN
 * If it is a registered probe, we send only its specifications, otherwise we send a 428 code with no specification
 */
app.get(supervisor.SUPERVISOR_PATH_SHOW_SPECIFICATION, function(req, res){
	showSpecifications(req , res);
});
gui_app.get( supervisor.GUI_LISTPENDINGS_PATH, function(req, res){
	showSpecifications(req , res);
});

/**
 * Someone is asking for capability(s)
 * We recognize the requester by its DN
 */
app.get(supervisor.SUPERVISOR_PATH_SHOW_CAPABILITY, function(req, res){
	showCapability(req , res);
});
gui_app.get(supervisor.GUI_LISTCAPABILITIES_PATH, function(req, res){
	showCapability(req , res);
});

/**
 * Someone is sending a result
 */
app.post(supervisor.SUPERVISOR_PATH_REGISTER_RESULT, function(req, res){
    var result = mplane.from_dict(req.body);
    if (mplane.isException(result)){
	 return res.status(403).send(result.toString());
    }
    var dn = DN(req)
        ,label = result.get_label()
        ,specHash = result.get_token();
    if (!(result instanceof mplane.Result)){
       return res.status(403).send("mPlane error: not a result/wrong format ");
    }
    if (!__results__[dn])
        __results__[dn] = {};
    if (! __results__[dn][label])
        __results__[dn][label] = {};
    if (! __results__[dn][label][specHash])
        __results__[dn][label][specHash] = {};
    result['eventTime'] = new Date(); // Time we registered the result
    __results__[dn][label][specHash] = result;
    res.send("OK");
});

/**
 * GUI asking for available results
 */

gui_app.get(supervisor.GUI_LISTRESULTS_PATH, function(req, res){
	var dns = _.keys(__results__);
	var ret = {};
	for (d=0 ; d<dns.length ; d++){
		var dn = dns[d];
		if (!ret[dn])
			ret[dn] = [];
		var labels = _.keys(__results__[dn]);
		for (l=0 ; l<labels.length ; l++){
			var label = labels[l];
			var tokens = _.keys(__results__[dn][label]);
			for (t=0 ; t<tokens.length ; t++){
				var specHash=tokens[t];
				ret[dn].push(JSON.parse(new mplane.Result(__results__[dn][label][specHash]).to_dict()));
			}
		}
	}
	
	res.send(JSON.stringify(ret));
});

/**
 * Someone is asking for results (WITH redeem)
 * If no redeem, send all available results
 */
app.all([supervisor.SUPERVISOR_PATH_SHOW_RESULT ], function(req, res){
	var redeem = mplane.from_dict(req.body);
	if (!__sent_receipts__[redeem.get_token()]){
		res.status(403).send( "Unexpected redemption");
		return;
	}

	// Read from receipt index details for accessing results
	var dn = __sent_receipts__[redeem.get_token()].dn;
	var label = __sent_receipts__[redeem.get_token()].label;
	var specHash = __sent_receipts__[redeem.get_token()].specificationToken;
	if (!__results__[dn] || !__results__[dn][label] || !__results__[dn][label][specHash]){
		res.status(403).send("Unexpected redemption");
		return;
	}
	// If a result exists, send it else send the receipt
	// Delete the result from available ones
	if (__results__[dn][label][specHash]){
		res.send(new mplane.Result(__results__[dn][label][specHash]).to_dict());
		// If not explicitly required, we delete claimed results
		if (!configuration.main.keep_claimed_results)
			delete __results__[dn][label][specHash];
	}else{
		res.send(new mplane.Receipt(__required_specifications__[dn][label][specHash]).to_dict());
	}
});


/**
 * GUI result details
 * The parameter is the Specification token
 */
gui_app.get(supervisor.GUI_GETRESULT_PATH , function(req, res){
	if (!req.query.token || !__sent_receipts__[req.query.token]){
		res.json({});
		return;
	}
	var ret = {};
	var dn = __sent_receipts__[req.query.token].dn;
	var label = __sent_receipts__[req.query.token].label;
	if (!ret[dn])
		ret[dn] = [];
	ret[dn].push(JSON.parse(new mplane.Result(__results__[dn][label][req.query.token]).to_dict()));
	res.send(new mplane.Result(__results__[dn][label][req.query.token]).to_dict());
});

app.get(supervisor.SUPERVISOR_PATH_INFO, function(req , res){
    supervisorInfo(null , res);
});

// Reasoner net status
// The supervisor simply ask the json to the reasoner agent and sends it back to the client
gui_app.get("/gui/reasoner/netview", function(req, res){
	var bodyChunks = [];
	var options = {
	  host: configuration.reasoner.url,
	  port: configuration.reasoner.port,
	  path: configuration.reasoner.path
	};

	var req = http.get(options, function(res1) {
	  res1.on('data', function(chunk) {
		// You can process streamed parts here...
		bodyChunks.push(chunk);
	  }).on('end', function() {
		var body = Buffer.concat(bodyChunks);
		//send the received body 
		try{
			res.send(body);
		}catch(e){
			//FIXME: Manage better the error
			//console.error(e);
		}
	  })
	});

	req.on('error', function(e) {
	  console.log('ERROR: ' + e.message);
	  res.sendStatus(500);
	});
	
});


//**************************************
// Redirect to default url. For the GUI
//**************************************
gui_app.use("", function(req , res){
	res.redirect(configuration.gui.defaultUrl);
});

app.use(pmx.expressErrorHandler());
gui_app.use(pmx.expressErrorHandler());


//====================================================================================================================



/**
 * Checks if a capability for a DN is already registered
 * @param capability
 * @param DN Distinguisched name
 * @returns {boolean}
 */
function capabilityAlreadyRegistered(capability , DN){
    if ((__registered_capabilities__[DN]) && (__registered_capabilities__[DN][capability.get_label()])){
        return true;
    }
    return false;
}

/*
 registerCapability
 Register a new capability for a specific DN
 Emits a DBChangedEvent
 @param the mPlane capability object to be registered
 @param DN the DN
 */
function registerCapability(capability , DN){
    var token = capability.get_label();
    if (!__registered_capabilities__[DN])
        __registered_capabilities__[DN] = {};
    if (!__registered_capabilities__[DN][token]){
        __registered_capabilities__[DN][token] = capability;
        __registered_capabilities__[DN][token]['eventTime'] = new Date(); // The time we registered the capability
        eventEmitter.emit('DBChangedEvent');
    }
    return token;
}

/*
	Register a DN and checks the uniqueness
	Emits a DBChangedEvent
*/
function registerDN(dn){
	__registered_DN__.push(dn);
    __registered_DN__ = _.uniq(__registered_DN__);
    eventEmitter.emit('DBChangedEvent');
}

function registerSpecification(req, res){
        var url = new String(req.url);
	var dns = [];
	var newSpecification;
	// Is the GUI request or the standard mPlane API?
	if (req.url.slice(0, supervisor.GUI_RUNCAPABILITY_PATH.length) == supervisor.GUI_RUNCAPABILITY_PATH){
		var urlParams = req.url.split("DN=");
		dns.push(urlParams[1]);
		newSpecification = new mplane.Specification(mplane.from_dict(req.body));
	}else{
		dns = _.keys(req.body); // We expect to have a DN as key, so dn[0] should be the DN
		newSpecification = mplane.from_dict(req.body[dns[0]]);
	}

   cli.debug("New SPECIFICATION from "+ dns[0]);

    if (!(newSpecification instanceof mplane.Specification)){
	cli.debug("mPlane error: not a specification/wrong format");
        // Bad Request
        res.writeHead(400, {
            'Error': "mPlane error: not a specification/wrong format"
        });
        res.end();
    }else{
        var dn = dns[0];
        var label = newSpecification.get_label();
        var specToken = newSpecification.get_token();
        if (!__required_specifications__[dn])
            __required_specifications__[dn] = {}; // We can have multiple request for a single component
        if (!__required_specifications__[dn][label])
            __required_specifications__[dn][label] = {}; // We can have multiple request for a single capability of a dn
        newSpecification.specification_status = __SPEC_STATUS_QUEUED_;
        __required_specifications__[dn][label][specToken]= {};
        __required_specifications__[dn][label][specToken]= newSpecification;
        __required_specifications__[dn][label][specToken]['eventTime']= new Date(); // When we received the specification

        // Receipt
        receipt = new mplane.Receipt(newSpecification);
        // We keep an index to easily access from the receipt token the associated specification/results
        if (!__sent_receipts__[receipt.get_token()])
            __sent_receipts__[receipt.get_token()] = {};
        __sent_receipts__[receipt.get_token()] = {dn:dn , label: label, specificationToken:specToken};
        res.send(receipt.to_dict());
    }
}

function showCapability(req , res){
    var ret = {};//Here we put all the DNs for filtering specifications from
    var dn = DN(req);
	
    for (dn in __registered_capabilities__){
        for (label in __registered_capabilities__[dn]){
            if (!ret[dn])
                ret[dn] = [];
            // We add in meta some useful info
            var cap = new mplane.Capability(__registered_capabilities__[dn][label]);
            cap.set_metadata_value('eventTime' ,__registered_capabilities__[dn][label]['eventTime'] || "");
            ret[dn].push(JSON.parse(cap.to_dict()));
        }
    };
    res.send(JSON.stringify(ret));
}

function showSpecifications(req , res){
	var ret,
        statusCode = 200
        ,DNs = [] //Here we put all the DNs for filtering specifications from
	// SDK 13052015
	var envelope = {
            "contents":[],
            "envelope": "message",
			"version": 1
        };

	// Is the GUI request or the standard mPlane API?
	if (req.url.slice(0, supervisor.GUI_LISTPENDINGS_PATH.length) == supervisor.GUI_LISTPENDINGS_PATH){
		ret = {};
	}else{
		ret = [];
	}
		var dn = DN(req);
		updateLasteSeen(dn);
			// Only the required DN or all DNs
			if (dn && __registered_DN__.indexOf(dn) != -1){
				DNs.push(dn);
			}else{
				_.each(_.keys(__required_specifications__), function(curDN){
					DNs.push(curDN);
				});
			}
			DNs.forEach(function(d,index){
				if (req.url.slice(0, supervisor.GUI_LISTPENDINGS_PATH.length) == supervisor.GUI_LISTPENDINGS_PATH){
					if (!ret[dn])
						ret[dn] = [];
				}
				_.each(_.keys(__required_specifications__[d]) , function(label){
					_.each(_.keys(__required_specifications__[d][label]) , function(specHash){
						if ((__required_specifications__[d][label][specHash].specification_status == __SPEC_STATUS_QUEUED_)) {
							var spec = new mplane.Specification(__required_specifications__[d][label][specHash]);
							// Usefull meta info
							spec.set_metadata_value("eventTime",__required_specifications__[d][label][specHash].eventTime);
							spec.set_metadata_value("specification_status",__required_specifications__[d][label][specHash].specification_status);
							// Better this solution to keep the API
							if (req.url.slice(0, supervisor.GUI_LISTPENDINGS_PATH.length) == supervisor.GUI_LISTPENDINGS_PATH){
								ret[dn].push(JSON.parse(spec.to_dict()));
							}else{
								ret.push(JSON.parse(spec.to_dict()));
								// Supervisor internal status
								__required_specifications__[d][label][specHash].specification_status = __SPEC_STATUS_PROBE_TAKEN_;
							}
						}
					});
				});
			});
			
		if (req.url.slice(0, supervisor.GUI_LISTPENDINGS_PATH.length) == supervisor.GUI_LISTPENDINGS_PATH){
			res.status(statusCode).end(JSON.stringify(ret));
		}else{
			if (ret[0])
				ret[0].registry = configuration.registry.url;
			envelope.contents = ret;
			res.status(statusCode).end(JSON.stringify(envelope));
		}
}

// ---------------------------------------------------------------
// Start the prompt
// ---------------------------------------------------------------
motd(function(){console.log("Supervisor listening on "+configuration.main.hostName+"@"+configuration.main.listenPort + " \nWEB GUI: "+configuration.main.hostName+"@"+configuration.main.webGuiPort);});

start_cli();

// ---------------------------------------------------------------

var prompt;

// parse cli params
// If the interactive cli is enabled,starts it
function start_cli(){
	
	// CLI params
	cli.parse({});
	
	if (!configuration.ssl.requestCert){
		cli.info("Certificatate request is DISABLED");
	}
	
	if (configuration.main.interactiveCli){
		var prompt = "mPlane - "+configuration.main.hostName+"@"+configuration.main.listenPort+"#";
         var questions = [
        {
            type: "list",
            name: "cmd",
            message: prompt,
            choices: [ "Show", "Specifications" , new inquirer.Separator() , "Quit" ],
            filter: function( val ) { return val.toLowerCase(); }
        },
            {
                type: "list",
                name: "showType",
                message: prompt+" (SHOW) ",
                choices: [ "Capabilities", "Specifications" , "Results"],
                when: function(curCmd){ return (curCmd.cmd == "show");},
                filter: function( val ) { return val.toLowerCase(); }
            },
            {
                type: "list",
                name: "cmd",
                message: "..."+prompt+"(SPECIFICATION)",
                choices: ["Define new specification" ,  "Delete a specification" , new inquirer.Separator() , "Done" ],
                when: function(curCmd){return (curCmd.cmd == "specifications");},
                filter: function( val ) { return val.toLowerCase(); }
            },
            {
                type: "list",
                name: "dn",
                message:  "..."+prompt+"(Registered Distinguished names)",
                choices: function(){
                    var h = _.keys(__registered_capabilities__);
                    if (h.length == 0)
                        return ["-- No dn yet --"];
                    else
                        return h;
                },
                when: function(curCmd){return ((curCmd.cmd == "define new specification") || (curCmd.cmd == "delete a specification"));}
            }, {
                type: "list",
                name: "capability",
                message:  "..."+prompt+"(CAPABILITIES)",
                choices: function(el){
                    var h = _.keys(__registered_capabilities__[el.dn]);
                    if (h.length == 0)
                        return ["-- No capabilities yet --"];
                    else
                        return h;
                },
                when: function(el){return(el.dn);}
            },
            {
                 type: "confirm",
                 name: "confirm_delete_specification",
                 message: "This will delete the specification. Are you sure?",
                 when: function(curCmd){return ((curCmd.cmd == "delete a specification"));},
                 filter: function( val ) { return val.toLowerCase(); }
            }

    ];

	/**************************************************
	* Warns the user if certs verification is disabled
	***************************************************/
	if (!configuration.ssl.requestCert){
		cli.info("---------------------------");
		cli.info("WARNING: SSL CERT DISABLED!");
		cli.info("---------------------------");
	}

    inquirer.prompt( questions, function( answers ) {
        switch (answers.cmd){
            case "quit":
                console.log("\nSEE YOU NEXT TIME!\n\n");
                httpsServer.close();
                return false;
                break;
            case "show":
                doShow(answers.showType);
                console.log("\n\n");
                start_cli();
                break;
            case "define new specification":
                if ((answers.dn == "-- No dn yet --") || (answers.capability == '-- No capabilities yet --')){
                    answers.dn = null;
                    start_cli();
                    break;
                }else{
                    console.log(answers);
                    // If all params have been chosen, go on
                    if (answers.dn && answers.capability){
                        queueSpecification(answers.capability , answers.dn);
                        console.log("\n\n");
                    }
                }

                break;
            case "delete a specification":
                if (answers.capability == "-- no capabilities yet --"){
                    start_cli();
                    break;
                }else{
                    if (answers.delete_specification)
                        deleteSpecification(answers.capability);
                    else
                        start_cli();
                }
                break;
            default:
                  console.log(answers)
        }
    });
	}

    
}


function doShow(args){
    switch (args.toLowerCase()){
        case "capabilities":
            if (_.keys(__registered_capabilities__).length == 0){
                console.log("---> NO DN registered YET <---");
                return true;
            }
            _.forEach(__registered_capabilities__ , function(index , DN , collection){
                console.log("-----------------------------------------------------------");
                console.log("---> ["+DN+"] <---");
                    _.forEach( __registered_capabilities__[DN] , function(index , token){
                        console.log("     ---> ["+token+"] <---");
                        console.log(prettyjson.render(__registered_capabilities__[DN][token]));
                    });
               });
            return true;
            break;
        case "specifications":
            if (_.keys(__required_specifications__).length == 0){
                console.log("---> NO specification queued <---");
                return true;
            }else{
                showSpecificationsToCLI();
                return true;
            }
            break;
        case "results":
            if (_.keys(__results__).length == 0){
                console.log("---> NO results available <---");
                return true;
            }else{
                showResults();
                return true;
            }
            break;
        default:
            return true;
    }

    return true;
}

/**
 * Adds a Specification to the internal db
 * @param capabilityHash hash of the capability we want to add a specification to
 * @param DN DN of the element
 */
function queueSpecification(capabilityHash , DN){
    if (typeof  capabilityHash == "undefined"){
        console.log("You should choose a capability");
        return false;
    }
    if (!__required_specifications__[DN])
        __required_specifications__[DN] = {}; // We can have multiple request for a single DN
    if (!__required_specifications__[DN][capabilityHash])
        __required_specifications__[DN][capabilityHash] = {}; // We can have multiple request for a single capability on a DN
    // The specification is created from the registered capability
    var spec = new mplane.Specification(__registered_capabilities__[DN][capabilityHash]);

    var inputParams = [ ];
    var paramNames = spec.parameter_names();

    var msg = "";
    var defaultValue = "";
    var parameters = spec.getAllParameters();
    _.forEach(parameters , function(par){
        var constr = par.getConstraints();
        var pn = par.getName().replace(/\s/gi , "_");
        // If we have no constraints, we want at least to check that the value is valid with respect to the primitive of the parameter
		var validateFunc = function(value){return (par.isValid(value))};
		msg = par.getDescription() ;
		// We can have 0 constraints
		if (_.keys(constr).length > 0){
            var constraint = new mplane.Constraints(constr['0']);
            switch (constraint.getType()){
	            case mplane.Constraints.SINGLETON:
	                defaultValue = constraint.getParam();
	                break;
	            case mplane.Constraints.RANGE:
	                defaultValue = constraint.getValA();
	                break;
	            case mplane.Constraints.LIST:
	                defaultValue = constraint.getParam()[0];
	                break;
	            default:
	        }
          	msg += " [" + constraint.unParse_constraint()+"]";
			validateFunc = function(value){return ((par.isValid(value) && par.met_by(value , undefined)));};
		}
        inputParams.push(
            {
                type: "input",
                name: pn,
                message: msg || "TBD",
                validate: validateFunc,
                default:defaultValue
            }
        )
    });

    // New prompt for input about parameters to be filled
    var paramsCli = inquirer.prompt( inputParams, function( userParams ) {
        // Do not confuse the name of the parameter in the specification parameters obj with the parameter name in the parameter itself!
        for (var parNum=0 ; parNum<paramNames.length ; parNum++) {
            par = parameters[parNum];
            try {
                var parName = par.getName();
                spec.setParameterValue(paramNames[parNum], userParams[parName.replace(/\s/gi, "_")]);
                spec.specification_status = __SPEC_STATUS_QUEUED_;
            } catch (e) {
                console.log(e)
            }
        }
        var specToken = spec.update_token();

        __required_specifications__[DN][capabilityHash][specToken]= {};
        __required_specifications__[DN][capabilityHash][specToken]= spec;
        console.log("Specification for "+capabilityHash+"@"+DN+" QUEUED ("+specToken+")");
        cli();
    });
}

function deleteSpecification( specToken){
    //FIXME: per adesso mi baso sul fatto che è praticamente impossibile che 2 specification abbiano lo stesso token
    //      Occorrerebbe passare anche l'hash della capability
    _.forEach(_.keys(__required_specifications__) , function(capHash){
        _.forEach(_.keys(__required_specifications__[capHash]) , function(specHash){
        })
    });
    if (__required_specifications__[capabilityHash][specToken])
        delete __required_specifications__[capabilityHash][specToken];
}

/**
 * Show queued specifications
 * @param capabilityHash
 * @param DN
 * @returns {boolean}
 */
function showSpecificationsToCLI(capabilityHash , DN){
    if (_.keys(__registered_capabilities__).length == 0){
        console.log("---> NO DN registered YET <---");
        return true;
    }

    // Are we asking for a specific capability or for all capabilities?
    if (!_.isUndefined(capabilityHash)){
        _.forEach(__registered_capabilities__[DN] , function(DN) {
            showSpecificationForCapability(capabilityHash , DN);
        });
    }
    else{
        var hashes = _.keys(__registered_capabilities__[DN]);
        _.forEach(hashes , function(hash){
            if (__required_specifications__[hash]){
                showSpecificationForCapability(hash);
                console.log( "\n");
            }
        });

        return true;
    }
}

/**
 * Show queued specifications
 * @param specificationHash
 * @returns {boolean}
 */
function showResults(capabilityHash , DN){
    if (_.keys(__registered_capabilities__).length == 0){
        console.log("---> NO DN registered YET <---");
        return true;
    }
    if (_.keys(__results__).length == 0){
        console.log("---> NO results available <---");
        return true;
    }

    // Are we asking for a specific capability or for all capabilities?
    if (!_.isUndefined(capabilityHash)){
        _.forEach(__registered_capabilities__[DN] , function(hash) {
            showResultForCapability(hash);
        });
    }
    else{
        var hashes = _.keys(__registered_capabilities__[DN]);
        _.forEach(hashes , function(hash){
            if (__results__[hash]){
                showResultForCapability(hash);
                console.log( "\n");
            }
        });

        return true;
    }
}

function showSpecificationForCapability(probeHash){
    console.log("+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++");
    console.log("Queued specification for "+probeHash);
    var specHashes = _.keys(__required_specifications__[probeHash]);
    for (var specNum=0 ; specNum<specHashes.length ; specNum++){
        var specToken = specHashes[specNum];
        console.log("------> Specification "+specToken+" <-------");
        console.log(prettyjson.render(new mplane.Specification( __required_specifications__[probeHash][specToken])));
        // We added a specification_status that is of significance only for the supervisor, so it is not considered by the mPlane lib
        console.log("---> STATUS: "+  __required_specifications__[probeHash][specToken].specification_status +" <---");
    }
    console.log("+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++");
}

function showResultForCapability(probeHash){
    console.log("+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++");
    // FIXME: mostrare anche la specifica!
    console.log("Results for "+probeHash);
    var resultHashes = _.keys(__results__[probeHash]);
    for (var resNum=0 ; resNum<resultHashes.length ; resNum++){
        var resToken = resultHashes[resNum];
        console.log("------> Result "+resToken+" <-------");
        console.log(prettyjson.render(new mplane.Result( __results__[probeHash][resToken])));
    }
    console.log("+++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++");
}

/**
 * * Info about this supervisor
 * If not item is specified, all info are sent back
 * TODO: implement the item filter
 * @param item
 * @param res
 */
function supervisorInfo(item , res){
    var ret = {};
    ret['node'] = process.versions;
    ret.pid = process.pid;
    ret.platform = process.platform;
    ret.arch = process.arch;
    ret.memory = process.memoryUsage();
    ret.upTime = process.uptime();
    res.send(JSON.stringify(ret));
}

//******************************
// DUMP TO FILE THE STATUS INFO
// ASYNCH!
//******************************
function dumpStatus(callback){
	// Simple way to be sure everything has been dumped...
	var done = [false, false];
	if (!configuration.dumpStatus.enabled){
		return callback();
	}else{
		cli.debug("DUMPING status to "+configuration.dumpStatus.dir);
		fs.outputFile(configuration.dumpStatus.dir + '/__registered_capabilities__.dump', JSON.stringify(__registered_capabilities__), function (err) {
  			if (err){
  				cli.error("Error dumping "+configuration.dumpStatus.dir + '/__registered_capabilities__.dump');
  			}
  			done[0] = true;
  			if (done[1] && callback)
  				callback();
		});
		fs.outputFile(configuration.dumpStatus.dir + '/__registered_DN__.dump', JSON.stringify(__registered_DN__), function (err) {
  			if (err){
  				cli.error("Error dumping "+configuration.dumpStatus.dir + '/__registered_DN__.dump');
  			}
  			done[1] = true;
  			if (done[0]  && callback)
  				callback();
		});
	}	
}

//******************************
// RESTORE FROM FILE THE STATUS INFO
// ASYNCH!
//******************************
function restoreStatus(){
	if (!configuration.dumpStatus.restoreOnStartup){
		cli.debug("RESTORE from status dump DISABLED");
		return;
	}else{
		cli.debug("Restoring status from "+configuration.dumpStatus.dir);
		fs.readFile(configuration.dumpStatus.dir + '/__registered_capabilities__.dump', 'utf8', function(err, data) {
			if (data)
    			__registered_capabilities__ = JSON.parse(data  || {});
  		});
		fs.readFile(configuration.dumpStatus.dir + '/__registered_DN__.dump', 'utf8', function(err, data) {
			if (data)
    			__registered_DN__ = JSON.parse(data || []);
  		});
	}	
}

//******************************

// Capabilities aging functions
function updateLasteSeen(dn){
	// Update last seen DN 
	if (dn){
		__last_seen_DNs__[dn] = new Date();
	}
}
function removeDeadCapabilities(){
	for (var i=0 ; i<__registered_DN__.length ; i++){
		dn = __registered_DN__[i];
		if (__last_seen_DNs__[dn]){
			var msecSinceLastSeen = (new Date() - __last_seen_DNs__[dn]);
			if (msecSinceLastSeen >= configuration.main.capabilityLostPeriod){
				cli.debug(dn + " LOST");
				__registered_DN__.splice(i, 1);
				delete (__last_seen_DNs__[dn]);
				delete (__registered_capabilities__[dn]);
				eventEmitter.emit('DBChangedEvent');
			}
		}else{
			cli.debug(dn + " LOST");
			// If I have no info of the DN, delete it!
			//delete (__registered_DN__[i]);
			__registered_DN__.splice(i, 1);
			delete (__last_seen_DNs__[dn]);
			delete (__registered_capabilities__[dn]);
			eventEmitter.emit('DBChangedEvent');
		}
	}
}

//******************************

/**
 * Given a request obj, returns, if available, the distinguised Name or null
 * @param req
 * @returns {null}
 * @constructor
 */
function DN(req){
    if (!req)
        return null;
    var details = req.connection.getPeerCertificate() || null;
    if (!details || !details.subjectaltname){
    	cli.debug("Error reading  DN "+details);
    	return null;
    }     
   // Extract the DNS altName
   var altName = details.subjectaltname.split(":"); 
   return(altName[1])
}

function motd(callback){
	console.log();
    console.log();
	console.log("    ###########################################");
	console.log("    ###$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$##");
	console.log("    ##$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$##");
	console.log("    ##$$$$$$$$$$$$$      $$$$$$$$$$$$$$$$$$$$##");
	console.log("    ##$$$$$$$$$$   ;$$$$   $$$$$$       $$$$$##");
	console.log("    ##$$$$$$$$   $$$$$$$$  $$$$   $$$$$  $$$$##");
	console.log("    ##$$$$$$   $$$$$$$$$$!      $$$$$$$   $$$##");
	console.log("    ##$$$$   $$$$$$$$$$$$$$  $$$$$$$$$$$  $$$##");
	console.log("    ##$$$  $$$$$$$$$$$$$$$$$$$$$$$$$$$$$  $$$##");
	console.log("    ##$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$##");
	console.log("    ###$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$$##");
	console.log("    ###########################################");

        console.log();
        console.log("               mPlane supervisor DEMO");
        console.log();
        console.log("    An Intelligent Measurement Plane for Future \n         Network and Application Management");
        console.log();
        console.log();
        callback();
}
