/*
 * Copyright (c) 2014 Adobe Systems Incorporated. All rights reserved.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 *
 */


/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50 */
/*global define, $, window, Mustache */

define(function (require, exports, module) {
    "use strict";
        
    var _                   = require("thirdparty/lodash"),
        FileSystem          = require("filesystem/FileSystem"),
        File                = require("filesystem/File"),
        InMemoryFile        = require("document/InMemoryFile"),
        ViewStateManager    = require("view/ViewStateManager"),
        MainViewManager     = require("view/MainViewManager"),
        DocumentManager     = require("document/DocumentManager"),
        CommandManager      = require("command/CommandManager"),
        Commands            = require("command/Commands"),
        paneTemplate        = require("text!htmlContent/pane.html");
    
    
    /**
     * Pane objects host views of files, editors, etc... 
     * 
     * To get a custom view, there are two components:
     * 
     *  1) A view provider (which will be implemented later
     *  2) A view object.
     *
     * View objects are anonymous object that have a particular interface. 
     *
     * Views can be added to a pane but do not have to exist in the Pane object's view list.  
     * Such views are "temporary views".  Temporary views are not serialized with the Pane state
     * or reconstituted when the pane is serialized from disk.  They are destroyed at the earliest
     * opportunity.
     *
     * Tempoary views are added by calling Pane.showView() and passing it the view object. The view 
     * will be destroyed when the next view is shown, the pane is mereged with another pane or the "Close All"
     * command is exectuted on the Pane.
     *
     * Views that have a longer life span are added by calling addView to associate the view with a 
     * filename in the _views object.  These views are not destroyed until they are removed from the pane
     * by calling one of the following: removeView, removeViews. , or reset
     *
     * Pane Object Events:
     * viewListChange - triggered whenever there is a change the the pane's view state
     * currentViewChange - triggered whenever the current view changes
     *
     * View Interface:
     *
     * {
     *      getFile: function () @return {?File} File object that belongs to the view (may return null)
     *      setVisible: function(visible:boolean) - shows or hides the view 
     *      updateLayout: function(forceRefresh:boolean) - tells the view to do ignore any cached layout data and do a complete layout of its content 
     *      destroy: function() - called when the view is no longer needed. 
     *      hasFocus:  function() - called to determine if the view has focus.  
     *      childHasFocus: function() - called to determine if a child component of the view has focus.  
     *      focus: function() - called to tell the view to take focus
     *      getScrollPos: function() - called to get the current view scroll state. @return {Object=}
     *      adjustScrollPos: function(state:Object=, heightDelta:number) - called to restore the scroll state and adjust the height by heightDelta
     *      switchContainers: function($newContainer:jQuery} - called to reparent the view to a new container
     *      getContainer: function() - called to get the current container @return {!jQuery} - the view's parent container
     *      getViewState: function() @return {?*} - Called when the pane wants the view to save its view state.  Return any data you needed to restore the view state later or undefined to not store any state
     *      restoreViewState: function(!viewState:*) - Called to restore the view state. The viewState argument is whatever data was returned from getViewState()
     * }
     *  
     * getFile()
     *
     *  Called throughout the life of a View when the current file is queried by the system.  Can be NULL
     *
     * setVisible()
     *
     *  Called when the view is shown or hidden.  When temporary views are hidden their destroy() method is called.
     *
     * updateLayout(forceRefresh:boolean)
     *  
     *  Called to notify the view that it should be resized to fit its parent container.  This may be called several times
     *  or only once.  Views can ignore the forceRefresh flag. It is used for editor views to force a relayout of the editor 
     *  which probably isn't necessary for most views.  Views should implement their html to be dynamic and not rely on this
     *  function to be called whenever possible.
     *
     * hasFocus()
     *
     *  Called throughout the life of the View to determine if the view has focus.
     *
     * childHasFocus()
     *
     *  Called throughout the life of the View to determine if a child compontent of the view has focus.  If the view has no child
     *  component then the view should just return false when this function is called.
     *
     * focus()
     *
     *  Called to tell the View to take focus.
     * 
     * getScrollPos()
     * adjustScrollPos()
     * 
     *  The system at various times may want to save and restore the view's scroll position.  The data returned by getScrollPos() is 
     *  specific to your view.  It will only be saved and passed back to adjustScrollPos() when the system wants the view to restore
     *  its scroll position.
     *
     *  When Modal Bars are invoked, the system calls getScrollPos() so that the current scroll psotion of all visible Views can be cahced. 
     *  Later, the cached scroll position data is passed to adjustScrollPos() along with a height delta.  The height delta is used to 
     *  scroll the view so that it doesn't appear to have "jumped" when invoking a modal bar. 
     *
     *  Height delta will be a positivewhen the Modal Bar is being shown and negative number when the Modal Bar is being hidden.  
     *  
     * switchContainers($newContainer)
     * 
     *  called when a Pane is being merged with another Pane.  
     * 
     *      `view.$el.detach().appendTo($newContainer);`
     *  
     *
     * getContainer()
     *
     *  Called to determine which Pane a View belongs to by MainViewManager.
     *
     * Events Dispatched from Pane Objects:
     *  
     *      viewListChange - triggered whenver the interal view list has changed due to the handling of a File object event.
     *          
     */
    
    /**
     * @typedef {getFile:function():?File, setVisible:function(visible:boolean), updateLayout:function(forceRefresh:boolean), destroy:function(), hasFocus:function():boolean, childHasFocus:function():boolean, focus:function(), getScrollPos:function():?,  adjustScrollPos:function(state:Object=, heightDelta:number), switchContainers: function($newContainer:jQuery}, getContainer: function():!jQuery, getViewState:function():?*, restoreViewState:function(viewState:!*)} View
     */
    
    /*
     * Pane Objects are constructed by the MainViewManager object when a Pane view is needed
     * @see {@link MainViewManager} for more information
     *
     * @constructor
     * @param {!string} id - The id to use to identify this pane
     * @param {!JQuery} $container - The parent $container to place the pane view
     */
    function Pane(id, $container) {
        this._initialize();
        
        // Setup the container and the element we're inserting
        var $el = $container.append(Mustache.render(paneTemplate, {id: id})).find("#" + id);
        
        // Make these properties read only
        Object.defineProperty(this,  "id", {
            get: function () {
                return id;
            },
            set: function () {
                console.error("cannot change the id of a working pane");
            }
        });

        Object.defineProperty(this,  "$el", {
            get: function () {
                return $el;
            },
            set: function () {
                console.error("cannot change the DOM node of a working pane");
            }
        });

        Object.defineProperty(this,  "$container", {
            get: function () {
                return $container;
            },
            set: function () {
                console.error("cannot change the DOM node of a working pane");
            }
        });

        // Listen to document events so we can update ourself
        $(DocumentManager).on(this._makeEventName("fileNameChange"),  _.bind(this._handleFileNameChange, this));
        $(DocumentManager).on(this._makeEventName("pathDeleted"), _.bind(this._handleFileDeleted, this));
    }

    /**
     * id of the pane
     * @readonly
     * @type {@return {}
     */
    Pane.prototype.id = null;
    
    /**
     * container where the pane lives
     * @readonly
     * @type {JQuery}
     */
    Pane.prototype.$container = null;
    
    /**
     * the wrapped DOM node of this pane
     * @readonly
     * @type {JQuery}
     */
    Pane.prototype.$el = null;
  
    /**
     * Initializes the Pane to its default state
     * @private
     */
    Pane.prototype._initialize = function () {
        this._viewList = [];
        this._viewListMRUOrder = [];
        this._viewListAddedOrder = [];
        this._views = {};
        this._currentView = null;
        this.showInterstitial(true);
    };
    
   /**
     * Creates a pane event namespaced to this pane
     * (pass an empty string to generate just the namespace key to pass to jQuery to turn off all events handled by this pane)
     * @private
     * @param {!string} name - the name of the event to namespace 
     * @return {string} an event namespaced to this pane
     */
    Pane.prototype._makeEventName = function (name) {
        return name + ".pane-" + this.id;
    };
    
    /**
     * Merges the another Pane object's contents into this Pane 
     * @param {!Pane} Other - Pane from which to copy 
     */
    Pane.prototype.mergeFrom = function (other) {
        // save this because we're setting it to null and we
        //  may need to destroy it if it's a temporary view
        var otherCurrentView = other._currentView;
        
        if (other._currentView) {
        // hide the current views and show the interstitial page
            otherCurrentView.setVisible(false);
            other.showInterstitial(true);
            other._currentView = null;
            // The current view is getting reset later but
            //  we're going to trigger this now and tell everyone 
            $(other).triggerHandler("currentViewChange", [null, otherCurrentView]);
        }

        // Copy the File lists
        this._viewList = _.union(this._viewList, other._viewList);
        this._viewListMRUOrder = _.union(this._viewListMRUOrder, other._viewListMRUOrder);
        this._viewListAddedOrder = _.union(this._viewListAddedOrder, other._viewListAddedOrder);
        
        var self = this,
            viewsToDestroy = [];

        // Copy the views
        _.forEach(other._views, function (view) {
            var file = view.getFile(),
                fullPath = file && file.fullPath;
            if (fullPath && other.findInViewList(fullPath) !== -1) {
                // switch the container to this Pane
                view.switchContainers(self.$el);
                self._views[fullPath] = view;
            } else {
                // We don't copy temporary views so destroy them
                viewsToDestroy.push(view);
            }
        });

        // 1-off views 
        if (otherCurrentView && !other._hasView(otherCurrentView)) {
            viewsToDestroy.push(otherCurrentView);
        }
        
        // Destroy temporary views
        _.forEach(viewsToDestroy, function (view) {
            view.destroy();
        });

        // this reset all internal data structures
        //  and will set the current view to null 
        other._initialize();
    };
    
    /**
     * Removes the DOM node for the Pane view
     */
    Pane.prototype.destroy = function () {
        $(DocumentManager).off(this._makeEventName(""));
        this.$el.remove();
    };
    
   /**
     * Returns a copy of the view file list
     * @return {!Array.<File>} 
     */
    Pane.prototype.getViewList = function () {
        return _.clone(this._viewList);
    };
    
    /**
     * Returns the number of entries in the view file list
     * @return {number} 
     */
    Pane.prototype.getViewListSize = function () {
        return this._viewList.length;
    };
    
    /**
     * determines if the specified input paramater is in range of the view file list 
     * @param {number} 
     * @private
     */
    Pane.prototype._isViewListIndexInRange = function (index) {
        var length = this._viewList.length;
        return index !== undefined && index !== null && index >= 0 && index < length;
    };
    
    /**
     * Returns the index of the item in the view file list 
     * @param {!string} fullPath the full path of the item to look for 
     * @return {number} index of the item or -1 if not found
     */
    Pane.prototype.findInViewList = function (fullPath) {
        return _.findIndex(this._viewList, function (file) {
            return file.fullPath === fullPath;
        });
    };
    
    /**
     * Returns the order in which the item was added
     * @param {!string} fullPath the full path of the item to look for 
     * @return {number} order of the item or -1 if not found
     */
    Pane.prototype.findInViewListAddedOrder = function (fullPath) {
        return _.findIndex(this._viewListAddedOrder, function (file) {
            return file.fullPath === fullPath;
        });
    };
    
   /**
     * Returns the order in which the item was last used
     * @param {!string} fullPath the full path of the item to look for 
     * @return {number} order of the item or -1 if not found. 
     *      0 indicates most recently used, followed by 1 and so on...
     */
    Pane.prototype.findInViewListMRUOrder = function (fullPath) {
        return _.findIndex(this._viewListMRUOrder, function (file) {
            return file.fullPath === fullPath;
        });
    };
    
    /** 
     * Return value from reorderItem when the Item was not found 
     * @see {@link reorderItem()}
     * @const 
     */
    Pane.prototype.ITEM_NOT_FOUND = -1;
    
    /** 
     * Return value from reorderItem when the Item was found at its natural index 
     * and the pane view list does not need to be resorted
     * @see {@link reorderItem()}
     * @const 
     */
    Pane.prototype.ITEM_FOUND_NO_SORT = 0;
    
    /** 
     * Return value from reorderItem when the Item was found and reindexed 
     * and the pane view list needs to be resorted
     * @see {@link reorderItem()}
     * @const 
     */
    Pane.prototype.ITEM_FOUND_NEEDS_SORT = 1;

    /**
     * reorders the specified file in the view list to the desired position
     *
     * @param {File} file - the file object of the item to reorder
     * @param {number=} index - the new position of the item
     * @param {boolean=} force - true to force the item into that position, false otherwise.  (Requires an index be requested)
     * @return {number} this function returns one of the following manifest constants:  
     *            ITEM_NOT_FOUND        : The request file object was not found   
     *            ITEM_FOUND_NO_SORT    : The request file object was found but it was already at the requested index   
     *            ITEM_FOUND_NEEDS_SORT : The request file object was found and moved to a new index and the list should be resorted   
     */
    Pane.prototype.reorderItem = function (file, index, force) {
        var indexRequested = (index !== undefined && index !== null && index >= 0),
            curIndex = this.findInViewList(file.fullPath);
        
        if (curIndex !== -1) {
            // File is in view list, but not at the specifically requested index - only need to reorder
            if (force || (indexRequested && curIndex !== index)) {
                var entry = this._viewList.splice(curIndex, 1)[0];
                this._viewList.splice(index, 0, entry);
                return this.ITEM_FOUND_NEEDS_SORT;
            }
            return this.ITEM_FOUND_NO_SORT;
        }
        
        return this.ITEM_NOT_FOUND;
    };
    
    /**
     * Adds the given file to the end of the pane view list, if it is not already in the list
     * @private
     * @param {!File} file
     * @param {Object=} inPlace record with inPlace add data (index, indexRequested). Used internally
     */
    Pane.prototype._addToViewList = function (file, inPlace) {
        if (inPlace && inPlace.indexRequested) {
            // If specified, insert into the pane view list at this 0-based index
            this._viewList.splice(inPlace.index, 0, file);
        } else {
            // If no index is specified, just add the file to the end of the pane view list.
            this._viewList.push(file);
        }
        
        // Add to MRU order: either first or last, depending on whether it's already the current doc or not
        var currentPath = this.getCurrentlyViewedPath();
        if (currentPath && currentPath === file.fullPath) {
            this._viewListMRUOrder.unshift(file);
        } else {
            this._viewListMRUOrder.push(file);
        }
        
        // Add first to Added order
        this._viewListAddedOrder.unshift(file);
    };

    
    /**
     * Determines if a file can be added to our file list
     * @private
     * @param {!File} file - file object to test
     * @return {boolean} true if it can be added, false if not
     */
    Pane.prototype._canAddFile = function (file) {
        return ((this._views.hasOwnProperty(file.fullPath) && this.findInViewList(file.fullPath) === -1) ||
                    (MainViewManager.canOpenFile(file) && !MainViewManager.getPaneIdForPath(file.fullPath)));
    };
                
    /**
     * Adds the given file to the end of the pane view list, if it is not already in the list
     * Does not change which document is currently open in the editor. Completes synchronously.
     * @param {!File} file - file to add
     * @param {number=} index - position where to add the item
     * @return {number} index of where the item was added
     */
    Pane.prototype.addToViewList = function (file, index) {
        var indexRequested = (index !== undefined && index !== null && index >= 0 && index < this._viewList.length);

        this._addToViewList(file, {indexRequested: indexRequested, index: index});
        
        if (!indexRequested) {
            index = this._viewList.length - 1;
        }
        
        return index;
    };
    

    /**
     * Adds the given file list to the end of the pane view list. 
     * @param {!Array.<File>} fileList
     * @return {!Array.<File>} list of files added to the list
     */
    Pane.prototype.addListToViewList = function (fileList) {
        var self = this,
            uniqueFileList = [];

        // Process only files not already in view list
        fileList.forEach(function (file) {
            if (self._canAddFile(file)) {
                self._addToViewList(file);
                uniqueFileList.push(file);
            }
        });

        return uniqueFileList;
    };
    
    /**
     * Removes the specifed file from all internal lists, destroys the view of the file (if there is one)
     *  and shows the interstitial page if the current view is destroyed
     * @private
     * @param {!File} file - file to remove
     * @return {boolean} true if removed, false if the file was not found either in a list or view
     */
    Pane.prototype._removeFromViewList = function (file) {
        
        // If it's in the view list then we need to remove it 
        var index = this.findInViewList(file.fullPath);
        
        if (index > -1) {
            // Remove it from all 3 view lists
            this._viewList.splice(index, 1);
            this._viewListMRUOrder.splice(this.findInViewListMRUOrder(file.fullPath), 1);
            this._viewListAddedOrder.splice(this.findInViewListAddedOrder(file.fullPath), 1);
        }
        
        // Destroy the view
        var view = this._views[file.fullPath];

        if (view) {
            if (this._currentView === view) {
                this.showInterstitial(true);
                this._currentView = null;
                $(this).triggerHandler("currentViewChange", [null, view]);
            }
            delete this._views[file.fullPath];
            view.destroy();
        }
        
        return ((index > -1) || !!view);
    };

    /**
     * Moves the specified file to the front of the MRU list
     * @param {!File} file
     */
    Pane.prototype.makeViewMostRecent = function (file) {
        var index = this.findInViewListMRUOrder(file.fullPath);
        if (index !== -1) {
            this._viewListMRUOrder.splice(index, 1);
            this._viewListMRUOrder.unshift(file);
        }
    };
    
    /**
     * Sorts items in the pane's view list
     * @param {function(!string, !string):number} compareFn - the function used to compare items in the viewList
     */
    
    /**
     * invokes Array.sort method on the internal view list. 
     * @param {sortFunctionCallback} compareFn - the function to call to determine if the 
     */
    Pane.prototype.sortViewList = function (compareFn) {
        this._viewList.sort(_.partial(compareFn, this.id));
    };

    /**
     * Swaps two items in the file view list (used while dragging items in the working set view)
     * @param {number} index1 - the index of the first item to swap
     * @param {number} index2 - the index of the second item to swap
     * @return {boolean}} true 
     */
    Pane.prototype.swapViewListIndexes = function (index1, index2) {
        if (this._isViewListIndexInRange(index1) && this._isViewListIndexInRange(index2)) {
            var temp = this._viewList[index1];
            this._viewList[index1] = this._viewList[index2];
            this._viewList[index2] = temp;
            return true;
        }
        return false;
    };
    
    /**
     * Traverses the list and returns the File object of the next item in the MRU order
     * @param {!number} direction - Must be 1 or -1 to traverse forward or backward
     * @param {string=} current - the fullPath of the item where traversal is to start. 
     *                              If this paramater is ommitted then the path of the current view is used.
     *                              If the current view is a temporary view then the first item in the MRU list is returned
     * @return {?File}  The File object of the next item in the travesal order or null if there isn't one.
     */
    Pane.prototype.traverseViewListByMRU = function (direction, current) {
        if (Math.abs(direction) !== 1) {
            console.error("traverseViewList called with unsupported direction: " + direction.toString());
            return null;
        }

        if (!current && this._currentView) {
            var file = this._currentView.getFile();
            current = file && file.fullPath;
        }
        
        var index = current ? this.findInViewListMRUOrder(current) : -1;
        if (index === -1) {
            // If doc not in view list, return most recent view list item
            if (this._viewListMRUOrder.length > 0) {
                return this._viewListMRUOrder[0];
            }
        } else if (this._viewListMRUOrder.length > 1) {
            // If doc is in view list, return next/prev item with wrap-around
            index += direction;
            if (index >= this._viewListMRUOrder.length) {
                index = 0;
            } else if (index < 0) {
                index = this._viewListMRUOrder.length - 1;
            }

            return this._viewListMRUOrder[index];
        }
        
        // If no doc open or view list empty, there is no "next" file
        return null;
    };
    
    /**
     * Event handler when a file changes name
     * @private
     * @param {!JQuery.Event} e - jQuery event object
     * @return {@return {} oldname - path of the file that was renamed
     * @return {@return {} newname - the new path to the file
     */
    Pane.prototype._handleFileNameChange = function (e, oldname, newname) {
        // because we store the File objects then   we don't really need to 
        // rename the file in the view map and dispatch a change event if we 
        // had a file object that was renamed so that our listeners can update 
        var dispatchEvent = (this.findInViewList(newname) >= 0);
        
        // rename the view 
        if (this._views.hasOwnProperty(oldname)) {
            var view = this._views[oldname];

            this._views[newname] = view;
            delete this._views[oldname];
        }
        
        // dispatch the change event
        if (dispatchEvent) {
            $(this).triggerHandler("viewListChange");
        }
    };

    /**
     * Event handler when a file is deleted
     * @private
     * @param {!JQuery.Event} e - jQuery event object
     * @return {@return {} fullPath - path of the file that was deleted
     */
    Pane.prototype._handleFileDeleted = function (e, fullPath) {
        if (this.removeView({fullPath: fullPath})) {
            $(this).triggerHandler("viewListChange");
        }
    };
    
    /**
     * Shows the pane's interstitial page
     * @param {boolean} show - show or hide the interstitial page
     */
    Pane.prototype.showInterstitial = function (show) {
        if (this.$el) {
            this.$el.find(".not-editor").css("display", (show) ? "" : "none");
        }
    };
    
    /**
     * retrieves the view object for the given path
     * @param {!string}  path - the fullPath of the view to retrieve
     * @return {boolean} show - show or hide the interstitial page
     */
    Pane.prototype.getViewForPath = function (path) {
        return this._views[path];
    };
    
    /**
     * Adds a view to the pane
     * @param {!View} view - the View object to add 
     * @param {boolean} show - true to show the view right away, false otherwise
     */
    Pane.prototype.addView = function (view, show) {
        var file = view.getFile(),
            path = file && file.fullPath;
        
        if (!path) {
            console.error("cannot add a view that does not have a fullPath");
            return;
        }
        
        this._views[path] = view;
        if (show) {
            this.showView(view);
        }
    };
    
    /**
     * Swaps the current view with the requested view. 
     * If the interstitial page is shown, it is hidden. 
     * If the currentView is a temporary view, it is destroyed.
     * @param {!View} view - the to show
     */
    Pane.prototype.showView = function (view) {
        if (this._currentView && this._currentView === view) {
            this._currentView.setVisible(true);
            this.updateLayout(true);
            return;
        }
        
        var file = view.getFile(),
            newPath = file && file.fullPath,
            oldView = this._currentView,
            oldPath = oldView && oldView.getFile() ? oldView.getFile().fullPath : null;
        
        if (this._currentView) {
            if (file) {
                ViewStateManager.setViewState(file, oldView.getViewState());
            }
            this._currentView.setVisible(false);
        } else {
            this.showInterstitial(false);
        }
        
        this._currentView = view;
        this._currentView.setVisible(true);
        this.updateLayout();
        $(this).triggerHandler("currentViewChange", [view, oldView]);
        
        if (oldPath) {
            // The old view is a temporary view because it 
            //  we not found in our view list
            if (this.findInViewList(oldPath) === -1) {
                delete this._views[oldPath];
                oldView.destroy();
            }
        } else if (oldView) {
            // Views that do not have a fullPath are always temporary views
            //  which are destroyed after the view has been hidden
            oldView.destroy();
        }
        
        if (newPath && (this.findInViewList(newPath) !== -1) && (!this._views.hasOwnProperty(newPath))) {
            console.error(newPath + " found in pane working set but pane.addView() has not been called for the view created for it");
        }
    };
    
    /**
     * Updates the layout causing the current view to redraw itself
     * @param {boolean} forceRefresh - true to force a resize and refresh of the current view, false if just to resize
     */
    Pane.prototype.updateLayout = function (forceRefresh) {
        if (this._currentView) {
            this._currentView.updateLayout(forceRefresh);
        }
    };
    
    /**
     * Determines if the pane has the specified view in its view list
     * @private
     * @param {!View} view - the View object to test
     */
    Pane.prototype._hasView = function (view) {
        var result = false;
        
        _.forEach(this._views, function (_view) {
            if (_view === view) {
                result = true;
                return false;
            }
        });
        
        return result;
    };
    
    
    /**
     * Determines if the view can be disposed of
     * @private
     * @param {!View} view - the View object to test
     * @return {boolean}} true if the view can be disposed, false if not
     */
    Pane.prototype._isViewNeeded = function (view) {
        var file = view.getFile(),
            path = file && file.fullPath,
            currentPath = this.getCurrentlyViewedPath();
        
        if (!path) {
            return false;
        }
        return ((this._currentView && currentPath === path) || (this.findInViewList(path) !== -1));
    };
    
    
    /**
     * Retrieves the File object of the current view
     * @return {?File} the File object of the current view or null if there isn't one
     */
    Pane.prototype.getCurrentlyViewedFile = function () {
        return this._currentView ? this._currentView.getFile() : null;
    };
    
    /**
     * Retrieves the path of the current view
     * @return {?string} the path of the current view or null if there isn't one
     */
    Pane.prototype.getCurrentlyViewedPath = function () {
        var file = this.getCurrentlyViewedFile();
        return file ? file.fullPath : null;
    };
    
    /**
     * destroys the view if it isn't needed
     * @param {View} view - the view to destroy
     */
    Pane.prototype.destroyViewIfNotNeeded = function (view) {
        if (view && !this._isViewNeeded(view)) {
            var file = view.getFile(),
                path = file && file.fullPath;
            delete this._views[path];
            view.destroy();
        }
    };
    
    /**
     * resets the pane to an empty state
     */
    Pane.prototype.reset = function () {
        var views = _.extend({}, this._views),
            view = this._currentView;

        if (view && !this._hasView(view)) {
            views = _.extend(views, {"<|?*:temporaryView:*?|>": view});
        }
        
        this._initialize();
        
        if (view) {
            $(this).triggerHandler("currentViewChange", [null, view]);
        }
        
        _.forEach(views, function (_view) {
            _view.destroy();
        });
    };
    
    /**
     * Executes a FILE_OPEN command to open a file
     * @param  {!string} fullPath - path of the file to open
     * @return {jQuery.promise} promise that will resolve when the file is opened
     */
    Pane.prototype._execOpenFile = function (fullPath) {
        return CommandManager.execute(Commands.FILE_OPEN, { fullPath: fullPath, paneId: this.id});
    };
    
    /**
     * Destroys the requested view
     * @param {File} file - the file to close
     * @param {boolean} suppressOpenNextFile - suppresses opening the next file in MRU order
     * @return {boolean} true if removed, false if the file was not found either in a list or view
     */
    Pane.prototype.removeView = function (file, suppressOpenNextFile) {
        var nextFile = !suppressOpenNextFile && this.traverseViewListByMRU(1, file.fullPath);
        if (nextFile && nextFile.fullPath !== file.fullPath && this.getCurrentlyViewedFile() === file) {
            var fullPath = nextFile.fullPath,
                needOpenNextFile = this._views.hasOwnProperty(fullPath);
            
            if (this._removeFromViewList(file)) {
                if (needOpenNextFile) {
                    this._execOpenFile(fullPath);
                }
                return true;
            }
            return false;
        }
        return this._removeFromViewList(file);
    };
    
    /**
     * Removes the specifed file from all internal lists, destroys the view of the file (if there is one)
     *  and shows the interstitial page if the current view is destroyed
     * @param {!Array.<File>}  list - Array of files to remove
     * @return {!Array.<File>} Array of File objects removed 
     */
    Pane.prototype.removeViews = function (list) {
        var self = this,
            fileList = [];
        
        if (!list) {
            return;
        }
        
        list.forEach(function (file) {
            if (self.removeView(file)) {
                fileList.push(file);
            }
        });
        
        return fileList;
    };
    
    /**
     * Gives focus to the current view if there is one or the pane if there isn't
     */
    Pane.prototype.focus = function () {
        if (this._currentView) {
            if (!this._currentView.hasFocus() && !this._currentView.childHasFocus()) {
                this._currentView.focus();
            }
        } else {
            this.$el.focus();
        }
    };
    
    /**
     * Called when the pane becomes the active pane
     * @param {boolean=} true if the pane is active, false if not
     */
    Pane.prototype.notifySetActive = function (active) {
        this.$el.toggleClass("active-pane", !!active);
    };
    
    /**
     * serializes the pane state
     * @param {!Object} state - the state to load 
     */
    Pane.prototype.loadState = function (state) {
        var filesToAdd = [],
            viewStates = {},
            activeFile,
            self = this;
        
        var getInitialViewFilePath = function () {
            return (self._viewList.length > 0) ? self._viewList[0].fullPath : null;
        };

        _.forEach(state, function (entry) {
            filesToAdd.push(FileSystem.getFileForPath(entry.file));
            if (entry.active) {
                activeFile = entry.file;
            }
            if (entry.viewState) {
                viewStates[entry.file] = entry.viewState;
            }
        });
        
        this.addListToViewList(filesToAdd);
        
        ViewStateManager.addViewStates(viewStates);
        
        activeFile = activeFile || getInitialViewFilePath();
        
        if (activeFile) {
            return this._execOpenFile(activeFile);
        }
        
        return new $.Deferred().resolve();
    };
    
    /**
     * serializes the pane state
     * @return {!Object} state - the state to save 
     */
    Pane.prototype.saveState = function () {
        var view,
            result = [],
            currentlyViewedPath = this.getCurrentlyViewedPath();

        // Save the current view state first
        if (this._currentView && this._currentView.getFile()) {
            ViewStateManager.setViewState(this._currentView.getFile(), this._currentView.getViewState());
        }
        
        // walk the list of views and save
        this._viewList.forEach(function (file) {
            // Do not persist untitled document paths
            if (!(file instanceof InMemoryFile)) {
                result.push({
                    file: file.fullPath,
                    active: (file.fullPath === currentlyViewedPath),
                    viewState:  ViewStateManager.getViewState(file)
                });
            }
        });
        
        return result;
    };
    
    /**
     * gets the current view's scroll state data
     * @return {Object=} scroll state - the current scroll state
     */
    Pane.prototype.getScrollState = function () {
        if (this._currentView) {
            return {scrollPos: this._currentView.getScrollPos()};
        }
    };
    
    /**
     * tells the current view to restore its scroll state from cached data and apply a height delta
     * @param {Object=} state - the current scroll state
     * @param {number=} heightDelta - the amount to add or subtract from the state
     */
    Pane.prototype.restoreAndAdjustScrollState = function (state, heightDelta) {
        if (this._currentView && state && state.scrollPos) {
            this._currentView.adjustScrollPos(state.scrollPos, heightDelta);
        }
    };
    
    exports.Pane = Pane;
});