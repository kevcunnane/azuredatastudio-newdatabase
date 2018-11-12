//
// Copyright (c) Kevin Cunnane. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as sqlops from 'sqlops';
import { Deferred } from './promise';

const mssql = 'MSSQL';

export class DatabaseCreator {
    private counter = 0;
    private connectionProvider: sqlops.ConnectionProvider;
    private connectionTracker = new Map<string, Deferred<void>>();

    constructor() {
        this.initConnectionProvider();
    }

    /**
     * Looks up connection provider if it doesn't exist, and registers to listen to connection complete events.
     * This lets us wait on a connection we request to be completed before running a query against it.
     *
     */
    private initConnectionProvider(): void {
        this.connectionProvider = sqlops.dataprotocol.getProvider<sqlops.ConnectionProvider>(mssql, sqlops.DataProviderType.ConnectionProvider);
        this.connectionProvider.registerOnConnectionComplete((summary: sqlops.ConnectionInfoSummary) => {
            let trackedPromise = this.connectionTracker.get(summary.ownerUri);
            if (trackedPromise) {
                if (summary.connectionId) {
                    // Having a connectionId indicates success (not sure why)
                    trackedPromise.resolve();
                } else {
                    trackedPromise.reject(summary.errorMessage);
                }
                this.connectionTracker.delete(summary.ownerUri);
            }
        });
    }


    /**
     * Prompts a user for database name and then connects to the existing DB and runs the create database command
     *
     * @param {sqlops.ObjectExplorerContext} context
     * @returns {Promise<void>}
     */
    public async createDatabase(context: sqlops.ObjectExplorerContext): Promise<void> {
        // Make sure we have a connection
        let connection = await this.lookupConnection(context);

        // Prompt the user for a new database name
        let dbName = await vscode.window.showInputBox({ prompt: `Name of database to create on server ${connection.options['server']}`, validateInput: (value) => value && value.length > 124 ? 'Must be 124 chars or less' : undefined});
        if (!dbName) {
            return;
        }

        // Run the create database as a task since it can take a few seconds to connect and execute the creation statement
        sqlops.tasks.startBackgroundOperation({
            connection: connection as sqlops.connection.Connection,
            displayName: `Creating Database ${dbName}`,
            description: '',
            isCancelable: false,
            operation: (op) => this.doCreateDatabase(op, dbName, connection)
        });

    }

    private async doCreateDatabase(operation: sqlops.BackgroundOperation, dbName: string, connection: sqlops.IConnectionProfile | sqlops.connection.Connection): Promise<void> {
        let tempUri = `untitled:createdb${this.counter++}`;
        let queryProvider = sqlops.dataprotocol.getProvider<sqlops.QueryProvider>(mssql, sqlops.DataProviderType.QueryProvider);
        let connected = false;
        try {
            operation.updateStatus(sqlops.TaskStatus.InProgress, 'Connecting to database');
            // Connect and execute a query. We use a temporary URI for this and dispose it on completion
            connected = await this.doConnect(tempUri, connection);
            if (!connected) {
                vscode.window.showErrorMessage('Failed to create connection, canceling create database operation');
                return;
            }

            operation.updateStatus(sqlops.TaskStatus.InProgress, 'Executing create database query');
            await this.runCreateDatabaseQuery(dbName, queryProvider, tempUri);

            // Notify on success
            let successMsg = `Database ${dbName} created. Refresh the Databases node to see it`;
            operation.updateStatus(sqlops.TaskStatus.Succeeded, successMsg);
            vscode.window.showInformationMessage(successMsg);
        } catch (error) {
            // Notify on failure
            let errorString = error instanceof Error ? error.message : error;
            let msg = 'Error adding database: ' + errorString;
            vscode.window.showErrorMessage(msg);
            operation.updateStatus(sqlops.TaskStatus.Failed, msg);
        } finally {
            if (connected) {
                // Disconnect and ignore any errors since a failure means the connection wasn't really established.
                this.connectionProvider.disconnect(tempUri).then(success => undefined, fail => undefined);
            }
        }

    }
    

    /**
     * Finds the connection, either passed into our callback or the current globally active connection.
     * It then ensures any credential needed for connection is present and returns.
     *
     * @param {sqlops.ObjectExplorerContext} context
     * @returns {(Promise<sqlops.IConnectionProfile | sqlops.connection.Connection>)}
     */
    private async lookupConnection(context: sqlops.ObjectExplorerContext): Promise<sqlops.IConnectionProfile | sqlops.connection.Connection> {
        let connection: sqlops.IConnectionProfile | sqlops.connection.Connection = undefined;
        if (context) {
            connection = context.connectionProfile;
        } else {
            connection = await sqlops.connection.getCurrentConnection();
            if (connection && connection.providerName === mssql) {
                let credentials = await sqlops.connection.getCredentials(connection.connectionId);
                connection.options = Object.assign(connection.options, credentials);
                let confirmed: boolean = await this.verifyConnectionIsCorrect(connection);
                if (!confirmed) {
                    // Return early to avoid information message
                    return undefined;
                }
            }
        }

        if (!connection) {
            vscode.window.showInformationMessage('Cannot create database as no active connection could be found');return;
        }
        return connection;
    }
    
    private async verifyConnectionIsCorrect(connection: sqlops.IConnectionProfile | sqlops.connection.Connection): Promise<boolean> {
        let confirmed = await vscode.window.showQuickPick([
            <ValuedQuickPickItem<boolean>>{ label: 'Yes', value: true },
            <ValuedQuickPickItem<boolean>>{ label: 'No', value: false }
        ], {
            placeHolder: `Create a new database on server ${connection.options['server']}?`
        });

        return confirmed && confirmed.value === true;
    }

    /**
     * This handles the async connection pattern used by Azure Data Studio. It sends a connection request and listens for a connection complete
     * response by storing a lookup value in a map that'll be called back when the connection complete for the URI we use is completed.
     * It'd be nice if there's was a cleaner "connectAndWait" method in the APIs so this kind of double-hop isn't needed, but this is the current
     * implementation.
     *
     * @param {string} uri a unique URI for this connection. Could refer to an editor but we're using a semi-GUID based approach so we can track the connection
     * @param {(sqlops.IConnectionProfile | sqlops.connection.Connection)} connection Information needed to connect
     * @returns {Promise<boolean>} A Promise that resolves to true/false depending on if connection succeeds
     */
    private async doConnect(uri: string, connection: sqlops.IConnectionProfile | sqlops.connection.Connection): Promise<boolean> {
        let deferred = new Deferred<void>();
        this.connectionTracker.set(uri, deferred);

        let connectRequested = await this.connectionProvider.connect(uri, connection);
        if (!connectRequested) {
            this.connectionTracker.delete(uri);
            return false;
        }
        try {
            // Wait on the connection to complete, or 15 seconds (mostly in case our logic is faulty)
            await Promise.race([deferred.promise, this.errorOnTimeout(15000)]);
        } catch (err) {
            return false;
        }
        return true;
    }

    private async runCreateDatabaseQuery(dbName: string, queryProvider: sqlops.QueryProvider, tempUri: string) {
        let query = `BEGIN TRY
    CREATE DATABASE [${dbName.replace(/]/g , "]]")}]
    SELECT 1 AS NoError
END TRY
BEGIN CATCH
    SELECT ERROR_MESSAGE() AS ErrorMessage;
END CATCH
`;
        let result = await queryProvider.runQueryAndReturn(tempUri, query);
        if (result.columnInfo[0].columnName === 'ErrorMessage') {
            throw new Error(result.rows[0][0].displayValue);
        }
    }

    private errorOnTimeout(ms: number): Promise<void> {
        return new Promise((resolve, reject) => setTimeout(reject, ms));
    }
}

interface ValuedQuickPickItem<T> extends vscode.QuickPickItem {
    value: T;
}
