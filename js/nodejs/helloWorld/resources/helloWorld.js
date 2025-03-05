module.exports = {
    helloWorld: {
        abi: {
            "ABI version": 2,
            "version": "2.4",
            "header": ["time", "expire"],
            "functions": [
                {
                    "name": "constructor",
                    "inputs": [
                        {"name":"value","type":"uint64"}
                    ],
                    "outputs": [
                    ]
                },
                {
                    "name": "exchangeToken",
                    "inputs": [
                        {"name":"value","type":"uint64"}
                    ],
                    "outputs": [
                    ]
                },
                {
                    "name": "renderHelloWorld",
                    "inputs": [
                    ],
                    "outputs": [
                        {"name":"value0","type":"string"}
                    ]
                },
                {
                    "name": "touch",
                    "inputs": [
                    ],
                    "outputs": [
                    ]
                },
                {
                    "name": "callExtTouch",
                    "inputs": [
                        {"name":"addr","type":"address"}
                    ],
                    "outputs": [
                    ]
                },
                {
                    "name": "sendVMShell",
                    "inputs": [
                        {"name":"dest","type":"address"},
                        {"name":"amount","type":"uint128"},
                        {"name":"bounce","type":"bool"}
                    ],
                    "outputs": [
                    ]
                },
                {
                    "name": "sendShell",
                    "inputs": [
                        {"name":"dest","type":"address"},
                        {"name":"value","type":"uint128"}
                    ],
                    "outputs": [
                    ]
                },
                {
                    "name": "deployNewContract",
                    "inputs": [
                        {"name":"stateInit","type":"cell"},
                        {"name":"initialBalance","type":"uint128"},
                        {"name":"payload","type":"cell"}
                    ],
                    "outputs": [
                    ]
                },
                {
                    "name": "timestamp",
                    "inputs": [
                    ],
                    "outputs": [
                        {"name":"timestamp","type":"uint32"}
                    ]
                }
            ],
            "events": [
            ],
            "fields": [
                {"init":true,"name":"_pubkey","type":"uint256"},
                {"init":false,"name":"_timestamp","type":"uint64"},
                {"init":false,"name":"_constructorFlag","type":"bool"},
                {"init":false,"name":"timestamp","type":"uint32"}
            ]
        },
        tvc: "te6ccgECIQEAA9sAAgE0AgEAWQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAQkiu1TIOMDIMD/4wIgwP7jAvILHgQDIAKUIds80wABjheDCNcYIPgoyM7OyfkAWPhCIPhl+RDyqN7TPwH4QyG58rQg+COBA+iogggbd0CgufK0+GPTHwH4I7zyudMfAds88jwYBQNS7UTQgQFA1yHXCgD4ZiLQ1wsDqTgA3CHHAOMCIdcNH/K8IeMDAds88jwdHQUEUCCCEDcxLkW74wIgghBwPeLPu+MCIIIQdtKRnLrjAiCCEHyaeH664wIPCggGAh4w+Eby4EzTP9HbPOMA8gAHGgEM+ADbPMcnFwM0MPhG8uBM+EJu4wAhk9TR0N76QNHbPOMA8gAYCRoBavhFIG6SMHDe+EK68uBm+ADbPMjPhYjOjQVOYloAAAAAAAAAAAAAAAAAAA3MS5FgzxbJcPsAFwM8IIIQaBflNbrjAiCCEGtJAFm64wIgghBwPeLPuuMCDgwLAjww+EJu4wD4RvJz0z/Rxyf4QvLgZfgA+CP4ats88gAYGgM8MPhG8uBM+EJu4wAhk9TR0N76QNN/0gDR2zzjAPIAGA0aAVb4RSBukjBw3vhCuvLgZvgA2zwBtXdZyM+FgMoAz4RAzgH6AoBsz0DJcPsAFwFQMNHbPPhKIY4cjQRwAAAAAAAAAAAAAAAAOgX5TWDIzssfyXD7AN7yABgEUCCCEAc0LEq64wIgghAeSP9RuuMCIIIQJzhZZbrjAiCCEDcxLkW64wIZFRIQAyQw+Eby4Ez4Qm7jANHbPNs88gAYERoBEPgA2zz4I/hqFwIiMPhG8uBM1NN/1NHbPOMA8gATGgJc+ADbPCL5AMjPigBAy//J0Fi1dwHIz4WIzgH6AnPPC2tUECDbPM8Uz4PMyXD7ABcUADTQ0gABk9IEMd7SAAGT0gEx3vQE9AT0BNFfAwM4MPhG8uBM+EJu4wAhk9TR0N76QNN/0ds84wDyABgWGgJo+EUgbpIwcN74Qrry4Gb4ANs8cm3IVQL6BlmAIPRDAcjPhYjOz4Qg9ABxzwtqiM8UyXH7ABcgACz4J28QghgXSHboALzcghgXSHboAMcoACjtRNDT/9M/0wDTH9H4avhm+GP4YgJcMPhG8uBM0ds8IY4bI9DTAfpAMDHIz4cgzoIQhzQsSs8LgczJcPsAkTDi4wDyABsaACT4SvhD+ELIy//LP8+Dyx/J7VQBAogcABRoZWxsb1dvcmxkAAr4RvLgTAIQ9KQg9L3ywE4gHwAUc29sIDAuNzcuMAAA",
    }
}