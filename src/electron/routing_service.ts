// Copyright 2018 The Outline Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {createConnection, Socket} from 'net';
import {platform} from 'os';
import * as sudo from 'sudo-prompt';

import * as errors from '../www/model/errors';

import {getServiceStartCommand} from './util';

const SERVICE_NAME =
    platform() === 'win32' ? '\\\\.\\pipe\\OutlineServicePipe' : '/var/run/outline_controller';

const isLinux = platform() === 'linux';

interface RoutingServiceRequest {
  action: string;
  parameters: {[parameter: string]: string|boolean};
}

interface RoutingServiceResponse {
  action: RoutingServiceAction;  // Matches RoutingServiceRequest.action
  statusCode: RoutingServiceStatusCode;
  errorMessage?: string;
  connectionStatus: ConnectionStatus;
}

enum RoutingServiceAction {
  CONFIGURE_ROUTING = 'configureRouting',
  RESET_ROUTING = 'resetRouting',
  STATUS_CHANGED = 'statusChanged'
}

enum RoutingServiceStatusCode {
  SUCCESS = 0,
  GENERIC_FAILURE = 1,
  UNSUPPORTED_ROUTING_TABLE = 2
}

// Communicates with the Outline routing daemon via a Unix socket.
//
// A minimal life-cycle is supported:
//  - CONFIGURE_ROUTING is *always* the first message sent on the pipe.
//  - The only subsequent supported operation is RESET_ROUTING.
//  - In the meantime, the client may receive zero or more STATUS_CHANGED events.
//
// That's it! This helps us connect to the service for *as short a time as possible* which is
// important when trying to implement a Promise-like interface over what is essentially a pipe *and*
// on Windows where only one client may be connected to the service at any given time.
//
// To test:
//  - Linux: systemctl start|stop outline_proxy_controller.service
//  - Windows: net start|stop OutlineService
export class RoutingDaemon {
  private socket: Socket|undefined;

  private fulfillDisconnect!: () => void;

  private disconnected = new Promise<void>((F) => {
    this.fulfillDisconnect = F;
  });

  private networkChangeListener?: (status: ConnectionStatus) => void;

  constructor(private proxyAddress: string, private isAutoConnect: boolean) {}

  // Fulfills once a connection is established with the routing daemon *and* it has successfully
  // configured the system's routing table.
  async start(retry = true) {
    return new Promise<void>((fulfill, reject) => {
      const newSocket = this.socket = createConnection(SERVICE_NAME, () => {
        newSocket.removeListener('error', initialErrorHandler);

        newSocket.once('data', (data) => {
          const message: RoutingServiceResponse = JSON.parse(data.toString());
          if (message.action !== RoutingServiceAction.CONFIGURE_ROUTING ||
              message.statusCode !== RoutingServiceStatusCode.SUCCESS) {
            // TODO: concrete error
            reject(new Error(message.errorMessage));
            newSocket.end();
            return;
          }

          newSocket.on('data', this.dataHandler.bind(this));
          fulfill();
        });

        newSocket.write(JSON.stringify({
          action: RoutingServiceAction.CONFIGURE_ROUTING,
          parameters: {'proxyIp': this.proxyAddress, 'isAutoConnect': this.isAutoConnect}
        } as RoutingServiceRequest));
      });

      const initialErrorHandler = () => {
        if (!(isLinux && retry)) {
          reject(new Error(`routing daemon is not running`));
          return;
        }

        console.info(`(re-)installing routing daemon`);
        sudo.exec(getServiceStartCommand(), {name: 'Outline'}, (sudoError) => {
          if (sudoError) {
            // NOTE: The script could have terminated with an error - see the comment in
            //       sudo-prompt's typings definition.
            reject(new errors.NoAdminPermissions());
            return;
          }

          fulfill(this.start(false));
        });
      };
      newSocket.once('error', initialErrorHandler);

      const cleanup = () => {
        newSocket.removeAllListeners();
        this.fulfillDisconnect();
      };
      newSocket.once('close', cleanup);
      newSocket.once('error', cleanup);
    });
  }

  private dataHandler(data: Buffer) {
    const message: RoutingServiceResponse = JSON.parse(data.toString());
    switch (message.action) {
      case RoutingServiceAction.STATUS_CHANGED:
        if (this.networkChangeListener) {
          this.networkChangeListener(message.connectionStatus);
        }
        break;
      case RoutingServiceAction.RESET_ROUTING:
        // TODO: examine statusCode
        if (this.socket) {
          this.socket.end();
        }
        break;
      default:
        console.error(`unexpected message from background service: ${data.toString()}`);
    }
  }

  // Use #onceDisconnected to be notified when the connection terminates.
  stop() {
    if (!this.socket) {
      // Never started.
      this.fulfillDisconnect();
      return;
    }

    this.socket.write(JSON.stringify(
        {action: RoutingServiceAction.RESET_ROUTING, parameters: {}} as RoutingServiceRequest));
  }

  public get onceDisconnected() {
    return this.disconnected;
  }

  public set onNetworkChange(newListener: ((status: ConnectionStatus) => void)|undefined) {
    this.networkChangeListener = newListener;
  }
}
