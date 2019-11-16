// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { Kernel, KernelMessage } from '@jupyterlab/services';
import { nbformat } from '@jupyterlab/services/node_modules/@jupyterlab/coreutils';
import 'rxjs/add/operator/concatMap';
import { IDisposable } from '../../client/common/types';
import { createDeferred, Deferred } from '../../client/common/utils/async';
import { noop } from '../../client/common/utils/misc';
import { deserializeDataViews } from '../../client/common/utils/serializers';
import { IInteractiveWindowMapping, InteractiveWindowMessages } from '../../client/datascience/interactive-common/interactiveWindowTypes';
import { PostOffice } from '../react-common/postOffice';
import { ProxyKernel } from './kernel';
import { IHtmlWidgetManager, IHtmlWidgetManagerCtor, IIPyWidgetManager, IMessageSender } from './types';

// The HTMLWidgetManager will be exposed in the global variable `window.ipywidgets.main` (check webpack config - src/ipywidgets/webpack.config.js).
// tslint:disable-next-line: no-any
const HtmlWidgetManager = (window as any).vscIPyWidgets.WidgetManager as IHtmlWidgetManagerCtor;
if (!HtmlWidgetManager) {
    throw new Error('HtmlWidgetManager not defined. Please include/check ipywidgets.js file');
}

export class WidgetManager implements IIPyWidgetManager, IMessageSender {
    public static instance: WidgetManager;
    public manager!: IHtmlWidgetManager;
    private readonly proxyKernel: ProxyKernel;
    private postOffice!: PostOffice;
    /**
     * Contains promises related to model_ids that need to be displayed.
     * When we receive a message from the kernel of type = `display_data` for a widget (`application/vnd.jupyter.widget-view+json`),
     * then its time to display this.
     * We need to keep track of this. A boolean is sufficient, but we're using a promise so we can be notified when it is ready.
     *
     * @private
     * @memberof WidgetManager
     */
    private modelIdsToBeDisplayed = new Map<string, Deferred<void>>();
    constructor(widgetContainer: HTMLElement) {
            this.proxyKernel = new ProxyKernel(this);
            // tslint:disable-next-line: no-any
            const kernel = (this.proxyKernel as any) as Kernel.IKernel;
            this.manager = new HtmlWidgetManager(kernel, widgetContainer);
            WidgetManager.instance = this;
    }
    public dispose(): void {
        this.proxyKernel.dispose();
    }
    public registerPostOffice(postOffice: PostOffice): void {
        this.postOffice = postOffice;
        // Process all messages sequentially.
        postOffice.asObservable()
            .concatMap(async msg => {
                this.restoreBuffers(msg.payload);
                await this.proxyKernel.handleMessageAsync(msg.type, msg.payload);
                await this.handleMessageAsync(msg.type, msg.payload);
            })
            .subscribe();
        this.proxyKernel.initialize();
    }
    public async clear(): Promise<void> {
        await this.manager.clear_state();
    }
    /**
     * This is the handler for all kernel messages.
     * All messages must be processed sequentially (even when processed asynchronously).
     *
     * @param {string} msg
     * @param {*} [payload]
     * @returns {Promise<void>}
     * @memberof WidgetManager
     */
    // tslint:disable-next-line: no-any
    public async handleMessageAsync(msg: string, payload?: any): Promise<void> {
        if (msg === InteractiveWindowMessages.IPyWidgets_display_data_msg) {
            // General IOPub message
            const displayMsg = payload as KernelMessage.IDisplayDataMsg;

            if (displayMsg.content &&
                displayMsg.content.data &&
                displayMsg.content.data['application/vnd.jupyter.widget-view+json']) {
                // tslint:disable-next-line: no-any
                const data = displayMsg.content.data['application/vnd.jupyter.widget-view+json'] as any;
                const modelId = data.model_id;

                if (!this.modelIdsToBeDisplayed.has(modelId)){
                    this.modelIdsToBeDisplayed.set(modelId, createDeferred());
                }
                const modelPromise = this.manager.get_model(data.model_id);
                if (modelPromise){
                    await modelPromise;
                }
                // Mark it as completed (i.e. ready to display).
                this.modelIdsToBeDisplayed.get(modelId)!.resolve();
            }
        }
    }
    /**
     * Renders a widget and returns a disposable (to remove the widget).
     *
     * @param {(nbformat.IMimeBundle & {model_id: string; version_major: number})} data
     * @param {HTMLElement} ele
     * @returns {Promise<{ dispose: Function }>}
     * @memberof WidgetManager
     */
    public async renderWidget(data: nbformat.IMimeBundle & {model_id: string; version_major: number}, ele: HTMLElement): Promise<IDisposable> {
        if (!data) {
            throw new Error('application/vnd.jupyter.widget-view+json not in msg.content.data, as msg.content.data is \'undefined\'.');
        }

        if (!data || data.version_major !== 2) {
            console.warn('Widget data not avaialble to render an ipywidget');
            return { dispose: noop };
        }

        const modelId = data.model_id as string;
        // Check if we have processed the data for this model.
        // If not wait.
        if (!this.modelIdsToBeDisplayed.has(modelId)){
            this.modelIdsToBeDisplayed.set(modelId, createDeferred());
        }
        // Wait until it is flagged as ready to be processed.
        // This widget manager must have recieved this message and performed all operations before this.
        // Once all messages prior to this have been processed in sequence and this message is receievd,
        // then, and only then are we ready to render the widget.
        // I.e. this is a way of synchronzing the render with the processing of the messages.
        await this.modelIdsToBeDisplayed.get(modelId)!.promise;

        const modelPromise = this.manager.get_model(data.model_id);
        if (!modelPromise) {
            console.warn('Widget model not avaialble to render an ipywidget');
            return { dispose: noop };
        }

        // ipywdigets may not have completed creating the model.
        // ipywidgets have a promise, as the model may get created by a 3rd party library.
        // That 3rd party library may not be available and may have to be downloaded.
        // Hence the promise to wait until it has been created.
        const model = await modelPromise;
        const view = await this.manager.create_view(model, { el: ele });
        // tslint:disable-next-line: no-any
        return this.manager.display_view(view, { el: ele }).then(vw => ({ dispose: vw.remove.bind(vw) }));
    }
    public sendMessage<M extends IInteractiveWindowMapping, T extends keyof M>(type: T, payload?: M[T]) {
        this.postOffice.sendMessage(type, payload);
    }
    private restoreBuffers(msg: KernelMessage.IIOPubMessage){
        if (!msg || !Array.isArray(msg.buffers) || msg.buffers.length === 0){
            return;
        }
        msg.buffers = deserializeDataViews(msg.buffers);
    }
}
