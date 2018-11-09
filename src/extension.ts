//
// Copyright (c) Kevin Cunnane. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

'use strict';

import * as vscode from 'vscode';

// The module 'sqlops' contains the SQL Operations Studio extensibility API
// This is a complementary set of APIs that add SQL / Data-specific functionality to the app
// Import the module and reference it with the alias sqlops in your code below

import * as sqlops from 'sqlops';
import { DatabaseCreator } from './databaseCreator';

let dbCreator: DatabaseCreator;

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.commands.registerCommand('newdatabase.createdb', async (context: sqlops.ObjectExplorerContext) => {
        if (!dbCreator) {
            dbCreator = new DatabaseCreator();
        }
        dbCreator.createDatabase(context);
    }));
}

// this method is called when your extension is deactivated
export function deactivate() {
}
