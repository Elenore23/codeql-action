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
Object.defineProperty(exports, "__esModule", { value: true });
exports.run = exports.tryUploadSarifIfRunFailed = void 0;
const actionsUtil = __importStar(require("./actions-util"));
const api_client_1 = require("./api-client");
const codeql_1 = require("./codeql");
const config_utils_1 = require("./config-utils");
const environment_1 = require("./environment");
const feature_flags_1 = require("./feature-flags");
const repository_1 = require("./repository");
const uploadLib = __importStar(require("./upload-lib"));
const util_1 = require("./util");
const workflow_1 = require("./workflow");
function createFailedUploadFailedSarifResult(error) {
    const wrappedError = (0, util_1.wrapError)(error);
    return {
        upload_failed_run_error: wrappedError.message,
        upload_failed_run_stack_trace: wrappedError.stack,
    };
}
/**
 * Upload a failed SARIF file if we can verify that SARIF upload is enabled and determine the SARIF
 * category for the workflow.
 */
async function maybeUploadFailedSarif(config, repositoryNwo, features, logger) {
    if (!config.codeQLCmd) {
        return { upload_failed_run_skipped_because: "CodeQL command not found" };
    }
    const workflow = await (0, workflow_1.getWorkflow)(logger);
    const jobName = (0, util_1.getRequiredEnvParam)("GITHUB_JOB");
    const matrix = (0, util_1.parseMatrixInput)(actionsUtil.getRequiredInput("matrix"));
    const shouldUpload = (0, workflow_1.getUploadInputOrThrow)(workflow, jobName, matrix);
    if (!["always", "failure-only"].includes(actionsUtil.getUploadValue(shouldUpload)) ||
        (0, util_1.isInTestMode)()) {
        return { upload_failed_run_skipped_because: "SARIF upload is disabled" };
    }
    const category = (0, workflow_1.getCategoryInputOrThrow)(workflow, jobName, matrix);
    const checkoutPath = (0, workflow_1.getCheckoutPathInputOrThrow)(workflow, jobName, matrix);
    const databasePath = config.dbLocation;
    const codeql = await (0, codeql_1.getCodeQL)(config.codeQLCmd);
    const sarifFile = "../codeql-failed-run.sarif";
    // If there is no database or the feature flag is off, we run 'export diagnostics'
    if (databasePath === undefined ||
        !(await features.getValue(feature_flags_1.Feature.ExportDiagnosticsEnabled, codeql))) {
        await codeql.diagnosticsExport(sarifFile, category, config);
    }
    else {
        // We call 'database export-diagnostics' to find any per-database diagnostics.
        await codeql.databaseExportDiagnostics(databasePath, sarifFile, category, config.tempDir, logger);
    }
    logger.info(`Uploading failed SARIF file ${sarifFile}`);
    const uploadResult = await uploadLib.uploadFromActions(sarifFile, checkoutPath, category, logger, { considerInvalidRequestUserError: false });
    await uploadLib.waitForProcessing(repositoryNwo, uploadResult.sarifID, logger, { isUnsuccessfulExecution: true });
    return uploadResult
        ? { ...uploadResult.statusReport, sarifID: uploadResult.sarifID }
        : {};
}
async function tryUploadSarifIfRunFailed(config, repositoryNwo, features, logger) {
    if (process.env[environment_1.EnvVar.ANALYZE_DID_COMPLETE_SUCCESSFULLY] !== "true") {
        try {
            return await maybeUploadFailedSarif(config, repositoryNwo, features, logger);
        }
        catch (e) {
            logger.debug(`Failed to upload a SARIF file for this failed CodeQL code scanning run. ${e}`);
            return createFailedUploadFailedSarifResult(e);
        }
    }
    else {
        return {
            upload_failed_run_skipped_because: "Analyze Action completed successfully",
        };
    }
}
exports.tryUploadSarifIfRunFailed = tryUploadSarifIfRunFailed;
async function run(uploadDatabaseBundleDebugArtifact, uploadLogsDebugArtifact, printDebugLogs, repositoryNwo, features, logger) {
    const config = await (0, config_utils_1.getConfig)(actionsUtil.getTemporaryDirectory(), logger);
    if (config === undefined) {
        logger.warning("Debugging artifacts are unavailable since the 'init' Action failed before it could produce any.");
        return;
    }
    const uploadFailedSarifResult = await tryUploadSarifIfRunFailed(config, repositoryNwo, features, logger);
    if (uploadFailedSarifResult.upload_failed_run_skipped_because) {
        logger.debug("Won't upload a failed SARIF file for this CodeQL code scanning run because: " +
            `${uploadFailedSarifResult.upload_failed_run_skipped_because}.`);
    }
    // Throw an error if in integration tests, we expected to upload a SARIF file for a failed run
    // but we didn't upload anything.
    if (process.env["CODEQL_ACTION_EXPECT_UPLOAD_FAILED_SARIF"] === "true" &&
        !uploadFailedSarifResult.raw_upload_size_bytes) {
        const error = JSON.stringify(uploadFailedSarifResult);
        throw new Error("Expected to upload a failed SARIF file for this CodeQL code scanning run, " +
            `but the result was instead ${error}.`);
    }
    if (process.env["CODEQL_ACTION_EXPECT_UPLOAD_FAILED_SARIF"] === "true") {
        await removeUploadedSarif(uploadFailedSarifResult, logger);
    }
    // Upload appropriate Actions artifacts for debugging
    if (config.debugMode) {
        logger.info("Debug mode is on. Uploading available database bundles and logs as Actions debugging artifacts...");
        await uploadDatabaseBundleDebugArtifact(config, logger);
        await uploadLogsDebugArtifact(config);
        await printDebugLogs(config);
    }
    return uploadFailedSarifResult;
}
exports.run = run;
async function removeUploadedSarif(uploadFailedSarifResult, logger) {
    const sarifID = uploadFailedSarifResult.sarifID;
    if (sarifID) {
        logger.startGroup("Deleting failed SARIF upload");
        logger.info(`In test mode, therefore deleting the failed analysis to avoid impacting tool status for the Action repository. SARIF ID to delete: ${sarifID}.`);
        const client = (0, api_client_1.getApiClient)();
        try {
            const repositoryNwo = (0, repository_1.parseRepositoryNwo)((0, util_1.getRequiredEnvParam)("GITHUB_REPOSITORY"));
            // Wait to make sure the analysis is ready for download before requesting it.
            await (0, util_1.delay)(5000);
            // Get the analysis associated with the uploaded sarif
            const analysisInfo = await client.request("GET /repos/:owner/:repo/code-scanning/analyses?sarif_id=:sarif_id", {
                owner: repositoryNwo.owner,
                repo: repositoryNwo.repo,
                sarif_id: sarifID,
            });
            // Delete the analysis.
            if (analysisInfo.data.length === 1) {
                const analysis = analysisInfo.data[0];
                logger.info(`Analysis ID to delete: ${analysis.id}.`);
                try {
                    await client.request("DELETE /repos/:owner/:repo/code-scanning/analyses/:analysis_id?confirm_delete", {
                        owner: repositoryNwo.owner,
                        repo: repositoryNwo.repo,
                        analysis_id: analysis.id,
                    });
                    logger.info(`Analysis deleted.`);
                }
                catch (e) {
                    const origMessage = (0, util_1.getErrorMessage)(e);
                    const newMessage = origMessage.includes("No analysis found for analysis ID")
                        ? `Analysis ${analysis.id} does not exist. It was likely already deleted.`
                        : origMessage;
                    throw new Error(newMessage);
                }
            }
            else {
                throw new Error(`Expected to find exactly one analysis with sarif_id ${sarifID}. Found ${analysisInfo.data.length}.`);
            }
        }
        catch (e) {
            throw new Error(`Failed to delete uploaded SARIF analysis. Reason: ${(0, util_1.getErrorMessage)(e)}`);
        }
        finally {
            logger.endGroup();
        }
    }
    else {
        logger.warning("Could not delete the uploaded SARIF analysis because a SARIF ID wasn't provided by the API when uploading the SARIF file.");
    }
}
//# sourceMappingURL=init-action-post-helper.js.map