import * as path from "path";
import { commands, Event, EventEmitter } from "vscode";
import { AppInsightsClient } from "./appInsightsClient";
import { Executor } from "./executor";
import { Logger } from "./logger";
import { TestDirectories } from "./testDirectories";
import { discoverTests, IDiscoverTestsResult } from "./testDiscovery";
import { TestNode } from "./testNode";
import { ITestResult, TestResult } from "./testResult";
import { TestResultsFile } from "./testResultsFile";
import { Utility } from "./utility";

export interface ITestRunContext {
    testName: string;
    isSingleTest: boolean;
}

export class TestCommands {
    private onTestDiscoveryStartedEmitter = new EventEmitter<string>();
    private onTestDiscoveryFinishedEmitter = new EventEmitter<IDiscoverTestsResult[]>();
    private onTestRunEmitter = new EventEmitter<ITestRunContext>();
    private onNewTestResultsEmitter = new EventEmitter<ITestResult>();
    private lastRunTestContext: ITestRunContext = null;

    constructor(
        private resultsFile: TestResultsFile,
        private testDirectories: TestDirectories) { }

    public discoverTests() {
        this.onTestDiscoveryStartedEmitter.fire();

        this.testDirectories.clearTestsForDirectory();

        // We want to make sure test discovery across multiple directories are run in sequence to avoid excessive cpu usage
        const runSeq = async () => {

            const discoveredTests = [];

            try {
                for (const dir of this.testDirectories.getTestDirectories()) {
                    const testsForDir: IDiscoverTestsResult = await discoverTests(dir, Utility.additionalArgumentsOption);
                    this.testDirectories.addTestsForDirectory(testsForDir.testNames.map( (tn) => ({dir, name: tn})));
                    discoveredTests.push(testsForDir);
                }

                this.onTestDiscoveryFinishedEmitter.fire(discoveredTests);
            } catch (error) {
                this.onTestDiscoveryFinishedEmitter.fire([]);
            }
        };

        runSeq();
    }

    public get onTestDiscoveryStarted(): Event<string> {
        return this.onTestDiscoveryStartedEmitter.event;
    }

    public get onTestDiscoveryFinished(): Event<IDiscoverTestsResult[]> {
        return this.onTestDiscoveryFinishedEmitter.event;
    }

    public get onTestRun(): Event<ITestRunContext> {
        return this.onTestRunEmitter.event;
    }

    public get onNewTestResults(): Event<ITestResult> {
        return this.onNewTestResultsEmitter.event;
    }

    public sendNewTestResults(testResults: ITestResult) {
        this.onNewTestResultsEmitter.fire(testResults);
    }

    public runAllTests(): void {
        this.runTestCommand("", false);
        AppInsightsClient.sendEvent("runAllTests");
    }

    public runTest(test: TestNode): void {
        this.runTestByName(test.fullName, !test.isFolder);
    }

    public runTestByName(testName: string, isSingleTest: boolean): void {
        this.runTestCommand(testName, isSingleTest);
        AppInsightsClient.sendEvent("runTest");
    }

    public rerunLastCommand(): void {
        if (this.lastRunTestContext != null) {
            this.runTestCommand(this.lastRunTestContext.testName, this.lastRunTestContext.isSingleTest);
            AppInsightsClient.sendEvent("rerunLastCommand");
        }
    }

    private runTestCommand(testName: string, isSingleTest: boolean): void {

        commands.executeCommand("workbench.view.extension.test", "workbench.view.extension.test")

        const testDirectories = this
            .testDirectories
            .getTestDirectories(testName);

        const testResults = [];

        // We want to make sure test runs across multiple directories are run in sequence to avoid excessive cpu usage
        const runSeq = async () => {

            for (let i = 0; i < testDirectories.length; i++) {
                testResults.push(await this.runTestCommandForSpecificDirectory(testDirectories[i], testName, isSingleTest, i));
            }

            const merged = [].concat(...testResults);
            this.sendNewTestResults({ testName, testResults: merged});
        };

        runSeq();
    }

    private runTestCommandForSpecificDirectory(testDirectoryPath: string, testName: string, isSingleTest: boolean, index: number): Promise<TestResult[]> {

        const trxTestName = index + ".trx";

        const textContext = {testName, isSingleTest};

        return new Promise((resolve) => {
            const testResultFile = path.join(Utility.pathForResultFile, "test-explorer", trxTestName);
            let command = `dotnet test${Utility.additionalArgumentsOption} --logger \"trx;LogFileName=${testResultFile}\"`;

            if (testName && testName.length) {
                if (isSingleTest) {
                    command = command + ` --filter FullyQualifiedName=${testName.replace(/\(.*\)/g, "")}`;
                } else {
                    command = command + ` --filter FullyQualifiedName~${testName.replace(/\(.*\)/g, "")}`;
                }
            }

            this.lastRunTestContext = textContext;
            Logger.Log(`Executing ${command} in ${testDirectoryPath}`);
            this.onTestRunEmitter.fire(textContext);

            Executor.exec(command, (err: Error, stdout: string) => {

                Logger.Log(stdout);

                this.resultsFile.parseResults(testResultFile).then( (result) => {
                    resolve(result);
                });
            }, testDirectoryPath);
        });
    }
}
