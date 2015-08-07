Supervisor
=================

[![mPlane](http://www.ict-mplane.eu/sites/default/files//public/mplane_final_256x_0.png)](http://www.ict-mplane.eu/)


This package contains a working example of a Supervisor Component of the [mPlane](http://www.ict-mplane.eu/) architecture. This implementation includes also a GUI backend.
The implementation leverages mPlane nodejs library and mPlane HTTPS transport library.

#Installation
Get all the code from github

```git clone https://github.com/finvernizzi/supervisor.git```

This command will install all the components and needed stuff in the supervisor folder.

```
LICENSE         README.md       guiconf.json    registry.json   ssl_files.js    
supervisor.js   supervisor.json www
```

Now you need to install all the nodejs dependencies
```
cd ./supervisor
npm install
```
Done. You are ready to run the supervisor.

    
#Configuration
    
In order to change the configuration edit the supervisor.json file.
This an example of working config

```json

main:{
        logFile:/var/log/mplane/supervisor.log,
        listenPort:2427,
        webGuiPort:8080,
        hostName:supervisor.ict-mplane.eu,
        interactiveCli:false,
        keep_claimed_results : true,
        capabilityLostPeriod: 100000
    },
     reasoner:{
             url:127.0.0.1,
             port:8081,
             path:/network_status.json
     },
    gui:{
        defaultUrl:/gui/static/login.html
        ,staticContentDir:/www
    },
    ssl:{
        key: ../certs/supervisors/Supervisor-plaintext.key
        ,cert: ../certs/supervisors/Supervisor.crt
        ,ca: [ ../certs/ca/root-ca.crt ]
        ,requestCert : true
    },
    dumpStatus:{
        enabled : false,
        file: .dump/supervisor_dump.json,
        dir: .dump,
        interval:10000,
        restoreOnStartup:true
    },
    registry:{
                url: http://ict-mplane.eu/registry/demo
    }
}

```

The configuration is a plain JSON file conataining 4 main sections described below.
###main
This section contains general configuration such as the log file location, the listen IP and PORTs (You should set a port for supervisor communications and another for the GUI API). 
`interactiveCli` enables f set to true, an interactive simple cli in order to see the status of the supervisor, informations collected (capabilities, specifications and so on) and instantiate Specifications for known Capabilities.  
If `keep_claimed_results` is true, the supervisor does not delete a result after it has been calimed with the correct receipt.

###reasoner
The configurations for interacting with the reasoner and in partcular for exposing in the GUI backend the network status as known by the reasoner.
`path` is where the supervisor will store the network status pushed by the reasoner.

###gui
Some details about the gui backend. Usually you do not chage these.

###SSL
Where to find ssl certificates and if they should be honoured or not.

###dumpStatus
If `enabled` the supervisor will periodically dump its internal db to file in order to reload it in case of restart (`restoreOnStartup`). `interval` set the period of dumps.

###registry
Where the supervisor should load its regitry. It can be any valid url, including local files.

#Run
To start the supervisor simply digit
```
node ./supervisor
```

#LICENSE
This software is released under the [BSD](https://en.wikipedia.org/wiki/BSD_licenses#2-clause_license_.28.22Simplified_BSD_License.22_or_.22FreeBSD_License.22.29) license.
