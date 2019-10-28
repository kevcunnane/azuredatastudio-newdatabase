//
// Copyright (c) Kevin Cunnane. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.
//

'use strict';

import * as vscode from 'vscode';
import * as azdata from 'azdata';
import { DatabaseCreator } from './databaseCreator';

let dbCreator: DatabaseCreator;

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(vscode.commands.registerCommand('newdatabase.createdb', async (context: azdata.ObjectExplorerContext) => {
        if (!dbCreator) {
            dbCreator = new DatabaseCreator();
        }
        dbCreator.createDatabase(context);
    }));
}

// this method is called when your extension is deactivated
export function deactivate() {
}
