"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const ava_1 = __importDefault(require("ava"));
const sinon = __importStar(require("sinon"));
const analyze_1 = require("./analyze");
const codeql_1 = require("./codeql");
const feature_flags_1 = require("./feature-flags");
const languages_1 = require("./languages");
const logging_1 = require("./logging");
const testing_utils_1 = require("./testing-utils");
const uploadLib = __importStar(require("./upload-lib"));
const util = __importStar(require("./util"));
(0, testing_utils_1.setupTests)(ava_1.default);
/**
 * Checks that the duration fields are populated for the correct language. Also checks the correct
 * search paths are set in the database analyze invocation.
 *
 * Mocks the QA telemetry feature flag and checks the appropriate status report fields.
 */
(0, ava_1.default)("status report fields and search path setting", async (t) => {
    let searchPathsUsed = [];
    return await util.withTmpDir(async (tmpDir) => {
        (0, testing_utils_1.setupActionsVars)(tmpDir, tmpDir);
        const memoryFlag = "";
        const addSnippetsFlag = "";
        const threadsFlag = "";
        sinon.stub(uploadLib, "validateSarifFileSchema");
        for (const language of Object.values(languages_1.Language)) {
            (0, codeql_1.setCodeQL)({
                packDownload: async () => ({ packs: [] }),
                databaseRunQueries: async (_db, searchPath) => {
                    searchPathsUsed.push(searchPath);
                },
                databaseInterpretResults: async (_db, _queriesRun, sarifFile) => {
                    fs.writeFileSync(sarifFile, JSON.stringify({
                        runs: [
                            // references a rule with the lines-of-code tag, so baseline should be injected
                            {
                                tool: {
                                    extensions: [
                                        {
                                            rules: [
                                                {
                                                    properties: {
                                                        tags: ["lines-of-code"],
                                                    },
                                                },
                                            ],
                                        },
                                    ],
                                },
                                properties: {
                                    metricResults: [
                                        {
                                            rule: {
                                                index: 0,
                                                toolComponent: {
                                                    index: 0,
                                                },
                                            },
                                            value: 123,
                                        },
                                    ],
                                },
                            },
                            {},
                        ],
                    }));
                    return "";
                },
                databasePrintBaseline: async () => "",
            });
            searchPathsUsed = [];
            const config = {
                languages: [language],
                originalUserInput: {},
                tempDir: tmpDir,
                codeQLCmd: "",
                gitHubVersion: {
                    type: util.GitHubVariant.DOTCOM,
                },
                dbLocation: path.resolve(tmpDir, "codeql_databases"),
                debugMode: false,
                debugArtifactName: util.DEFAULT_DEBUG_ARTIFACT_NAME,
                debugDatabaseName: util.DEFAULT_DEBUG_DATABASE_NAME,
                augmentationProperties: {
                    packsInputCombines: false,
                    queriesInputCombines: false,
                },
                trapCaches: {},
                trapCacheDownloadTime: 0,
            };
            fs.mkdirSync(util.getCodeQLDatabasePath(config, language), {
                recursive: true,
            });
            const statusReport = await (0, analyze_1.runQueries)(tmpDir, memoryFlag, addSnippetsFlag, threadsFlag, undefined, config, (0, logging_1.getRunnerLogger)(true), (0, testing_utils_1.createFeatures)([feature_flags_1.Feature.QaTelemetryEnabled]));
            t.deepEqual(Object.keys(statusReport).sort(), [
                `analyze_builtin_queries_${language}_duration_ms`,
                "event_reports",
                `interpret_results_${language}_duration_ms`,
            ]);
            for (const eventReport of statusReport.event_reports) {
                t.deepEqual(eventReport.event, "codeql database interpret-results");
                t.true("properties" in eventReport);
                t.true("alertCounts" in eventReport.properties);
            }
        }
    });
});
function mockCodeQL() {
    return {
        getVersion: async () => (0, testing_utils_1.makeVersionInfo)("1.0.0"),
        databaseRunQueries: sinon.spy(),
        databaseInterpretResults: async () => "",
        databasePrintBaseline: async () => "",
    };
}
function createBaseConfig(tmpDir) {
    return {
        languages: [],
        originalUserInput: {},
        tempDir: "tempDir",
        codeQLCmd: "",
        gitHubVersion: {
            type: util.GitHubVariant.DOTCOM,
        },
        dbLocation: path.resolve(tmpDir, "codeql_databases"),
        debugMode: false,
        debugArtifactName: util.DEFAULT_DEBUG_ARTIFACT_NAME,
        debugDatabaseName: util.DEFAULT_DEBUG_DATABASE_NAME,
        augmentationProperties: {
            packsInputCombines: false,
            queriesInputCombines: false,
        },
        trapCaches: {},
        trapCacheDownloadTime: 0,
    };
}
async function runQueriesWithConfig(config, features) {
    for (const language of config.languages) {
        fs.mkdirSync(util.getCodeQLDatabasePath(config, language), {
            recursive: true,
        });
    }
    return (0, analyze_1.runQueries)("sarif-folder", "--memFlag", "--addSnippetsFlag", "--threadsFlag", undefined, config, (0, logging_1.getRunnerLogger)(true), (0, testing_utils_1.createFeatures)(features));
}
function getDatabaseRunQueriesCalls(mock) {
    return mock.databaseRunQueries.getCalls();
}
(0, ava_1.default)("optimizeForLastQueryRun for one language", async (t) => {
    return await util.withTmpDir(async (tmpDir) => {
        const codeql = mockCodeQL();
        (0, codeql_1.setCodeQL)(codeql);
        const config = createBaseConfig(tmpDir);
        config.languages = [languages_1.Language.cpp];
        await runQueriesWithConfig(config, []);
        t.deepEqual(getDatabaseRunQueriesCalls(codeql).map((c) => c.args[4]), [true]);
    });
});
(0, ava_1.default)("optimizeForLastQueryRun for two languages", async (t) => {
    return await util.withTmpDir(async (tmpDir) => {
        const codeql = mockCodeQL();
        (0, codeql_1.setCodeQL)(codeql);
        const config = createBaseConfig(tmpDir);
        config.languages = [languages_1.Language.cpp, languages_1.Language.java];
        await runQueriesWithConfig(config, []);
        t.deepEqual(getDatabaseRunQueriesCalls(codeql).map((c) => c.args[4]), [true, true]);
    });
});
//# sourceMappingURL=analyze.test.js.map