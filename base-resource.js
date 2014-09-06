angular.module('stylistportal.mixins').factory('BaseResource',
['$injector', '$filter','$q', '$resource', 'CSRFService',
function($injector, $filter, $q, $resource, CSRFService) {
    /*
    * BaseResource is a wrapper around ng $resource for Stylist API requests
    *   - Abort & throttle web requests
    *   - Cross site & common headers
    *
    * Extending:
    *   angular.module('stylistportal.emails').factory('CustomService',
    *   ['$resource', 'BaseService',
    *   function ($resource, BaseService) {
    *       var url = '/admin/stylist_portal/api/v1/emails/';
    *       var actions = {
    *           new: {
    *               method: 'get',
    *               url: baseUrl + 'new'
    *               }
    *       }
    *
    *       //--- Extend BaseResource ---
    *       BaseService.extend(this, url, actions);
    *       return this.getResource();
    *   }]);
    *
    * Usage:
    *   var request = CustomService.query();
    *   ...
    *   request.abort();
    *   ...
    *   $scope.on('destroy', function() { CustomService.abortAll() });
    *
    */

    //--- Constructor ---

    function BaseResource() {
        this.prototype = Object.create(BaseResource.prototype);

        //--- Public Methods ---

        this.getResource = function() { return this.prototype.createResourceService(); }
    }

    //--- Base Service Prototype ---

    BaseResource.prototype = {
        BASE_URL: '/admin/stylist_portal/api/v1/*/',
        BASE_UPDATE_HEADERS: {'X-CSRF-Token': CSRFService.token()},
        BASE_ACTIONS : {
            query: {
                method: 'get',
                isArray: true,
                allowMulti: true   // Throttle query requests
            },
            create: { method: 'post'},
            update: { method: 'put' },
            delete: { method: 'delete' }
        },

        PARAMS: { id:'@id' },
        CUSTOM_ACTIONS : null,

        _resource : null,

        //--- Protected ---

        /*
        * Create and build our custom resource service
        *
        * @return the ng $resource
        */
        createResourceService: function() {
            this._resource = this.createAndExtendNgResource();
            this.buildActions();

            return this._resource;
        },

        /*
        * Create ng $resource and extend it with functionality for managing requests (AbortableResourceClass)
        *
        * @return the ng $resource
        */
        createAndExtendNgResource: function() {
            var resource = $resource(this.BASE_URL + ':id', this.PARAMS, this.CUSTOM_ACTIONS);

            // Extend this $resource with custom behaviour
            angular.extend(resource, this.AbortableResourceClass);
            resource.url = this.BASE_URL;

            return resource;
        },

        /*
        * For each of our resource actions (query, get, create, etc), wrap them with custom actions
        *
        */
        buildActions: function() {
            var _instance = this;

            angular.forEach(this.CUSTOM_ACTIONS, function(action, key) {
                var method = _instance._resource[key];
                action.headers = action.headers || method.method != 'get' ? _instance.BASE_UPDATE_HEADERS : null;

                _instance._resource[key] = _instance.wrapRequest(method, action, key);
            });
        },

        /*
        * Return an abortable function wrapper that will be invoked for all $resource actions
        *
        * @param method - the $resource method to invoke
        * @param action - the original $resource action from BASE_ACTIONS
        * @param key - the action name
        *
        * @return function
        */
        wrapRequest: function(method, action, key) {
            return function() {
                var promise, deferred = $q.defer(), $response = {};
                action.timeout = deferred.promise;

                if( this._shouldThrottle(action, key) === false) {
                    // Invoke our action with original arguments
                    $response = method.apply(this, arguments);
                    promise = this._abortablePromise(key, $response, deferred, this._requests);
                }
                else { promise = deferred.promise; }

                /* Preserve & extend the original response - From Angular (https://docs.angularjs.org/api/ngResource/service/$resource):
                *   It is important to realize that invoking a $resource object method immediately returns an empty
                *   reference (object or array depending on isArray). Once the data is returned from the server the
                *   existing reference is populated with the actual data.
                */
                return angular.extend($response, {
                    $promise: promise,
                    abort: this.abort(key, deferred)
                });
            };
        },

        AbortableResourceClass: {

            //--- Public (scope is $resource) ---

            url: '',
            hasPending: false,

            /*
            * Return a function that can be invoked to abort current request
            *
            * @param deferred - the deferred for this request
            *
            * @return function
            */
            abort: function(key, deferred) {
                var resource = this;

                return function() {
                    deferred.resolve('aborted');
                    resource._completeRequest(key, deferred);

                    return true;
                };
            },

            /*
            * Abort all pending requests for this resource
            *
            */
            abortAll: function() {
                angular.forEach(this._requests, function(requests, key) {
                    requests.forEach(function(deferred) { deferred.resolve('aborted'); });
                });

                this._requests = {};
                this.hasPending = false;
            },

            //--- Internal (scope is $resource) ---

            _requests : { },

            /*
            * Return a managed promise that can be aborted
            *
            * @param key - the action name
            * @param method - the $resource method to invoke and manage
            * @param deferred - the deferred for this request
            * @param requests - the requests cache
            * @param args - the original method args
            *
            * @return promise - request promise
            */
            _abortablePromise: function(key, response, deferred, requests) {
                var promise = response.$promise, resource = this;

                promise.then(function(result) { deferred.resolve.apply(deferred, arguments); });
                promise.catch(function() { deferred.reject.apply(deferred, arguments); });

                deferred.promise.finally(function() { resource._completeRequest(key, deferred); });

                requests[key] = requests[key] || [];
                requests[key].push(deferred);

                this.hasPending = true;
                return promise;
            },

            /*
            * Whether we should throttle this request
            *
            * @param action - the original resource action
            * @param key - the action name
            *
            * @return boolean - true if we should throttle
            */
            _shouldThrottle: function(action, key) {
                if (action.allowMulti || action.allowMulti == undefined) return false;

                return this._requests[key] && this._requests[key].length > 0;
            },

            /*
            * Once this request is complete, clear from requests cache
            *
            * @param key - the action name
            * @param deferred - the deferred for this request
            *
            */
            _completeRequest: function(key, deferred) {
                var requests = this._requests;
                if(requests[key]) { requests[key].splice(requests[key].indexOf(deferred), 1); }

                //TODO - is this a global or local flag? FLATTEN
                this.hasPending = requests[key] && requests[key].length > 0;
            }

        }

    };

    //---  Dependency Injector ---

    /*
    * Extend BaseResource
    *
    * @param service - the extending service
    * @param baseUrl - the base url for this resource
    * @param customActions - the custom resource actions
    * @param customParams - the custom resource parameters
    * @param include - the only actions to include from base set
    */
    BaseResource.extend = function(service, baseUrl, customActions, customParams, include){
        // Must specify dependencies using array form even though we are using locals (locals are looked up by name)
        var resourceServiceCreator = [BaseResource] ;
        $injector.invoke(resourceServiceCreator, service, {});

        // Remove any excluded actions from our base set
        var actions = angular.copy(service.prototype.BASE_ACTIONS);
        angular.forEach(actions, function(action, key) {
            if( include && include.indexOf(key) < 0) { delete actions[key]; }
        });

        service.prototype.BASE_URL = baseUrl;
        service.prototype.CUSTOM_ACTIONS = angular.extend(actions, customActions);
        service.prototype.PARAMS = customParams || service.prototype.PARAMS;
    };

    return( BaseResource );

}]);
