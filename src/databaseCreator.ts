//
// Copyright (c) Kevin Cunnane. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as sqlops from 'sqlops';
import { ConnectionContext } from 'azuredatastudio-dmpwrapper';
const mssql = 'MSSQL';

export class DatabaseCreator {

    constructor() {
    }

    /**
     * Prompts a user for database name and then connects to the existing DB and runs the create database command
     *
     * @param {sqlops.ObjectExplorerContext} context
     * @returns {Promise<void>}
     */
    public async createDatabase(context: sqlops.ObjectExplorerContext): Promise<void> {
        // Make sure we have a connection (handle command palette vs. context menu entry points)
        let connection = await this.lookupConnection(context);
        if (!connection) {
            vscode.window.showInformationMessage('Cannot create database as no active connection could be found');
            return;
        }

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
        
        let connectionProvider = sqlops.dataprotocol.getProvider<sqlops.ConnectionProvider>(mssql, sqlops.DataProviderType.ConnectionProvider);
        let connectionContext = new ConnectionContext(connectionProvider);

        try {
            // 1. Connect to the server
            operation.updateStatus(sqlops.TaskStatus.InProgress, 'Connecting to database');
            let connected = await connectionContext.tryConnect(connection);
            if (!connected) {
                vscode.window.showErrorMessage('Failed to connect, canceling create database operation');
                return;
            }

            // 2. Run Create Database query 
            operation.updateStatus(sqlops.TaskStatus.InProgress, 'Executing create database query');
            let query = `BEGIN TRY
    CREATE DATABASE [${dbName.replace(/]/g , "]]")}]
    SELECT 1 AS NoError
END TRY
BEGIN CATCH
    SELECT ERROR_MESSAGE() AS ErrorMessage;
END CATCH
`;
            let result = await connectionContext.runQueryAndReturn(query);
            if (result.columnInfo[0].columnName === 'ErrorMessage') {
                throw new Error(result.rows[0][0].displayValue);
            }
            
            // 3. Notify on success
            let successMsg = `Database ${dbName} created. Refresh the Databases node to see it`;
            operation.updateStatus(sqlops.TaskStatus.Succeeded, successMsg);
            vscode.window.showInformationMessage(successMsg);
        } catch (error) {
            // 4. Notify on failure
            let errorString = error instanceof Error ? error.message : error;
            let msg = 'Error adding database: ' + errorString;
            vscode.window.showErrorMessage(msg);
            operation.updateStatus(sqlops.TaskStatus.Failed, msg);
        } finally {
            connectionContext.dispose();
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
}

interface ValuedQuickPickItem<T> extends vscode.QuickPickItem {
    value: T;
}
