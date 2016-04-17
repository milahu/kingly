// TODO : check if fsm is multi-instances (i.e. new instance every time, no shared data)
// TODO : switch internal state machine to synchronous state machine?? I'd say yes
// TODO : add the weak abortion feature? unless it can be simulated with standard statechart?
//        for instance, action = http request, and cancel event in same state, no need for weak abortion
// TODO : add new feature : actions can send events - first design it
// TODO : architecture a la ELM, write actions as a comonad
//        in the action enum, maybe add a breakdown of the action into pure (model update), and effectful
//        maybe through a type, like {STOP : new Effect(action_def), START : {pure : action_def, effect : effect_def}
//        when only effect, the pure is identity
//        or type constructor new Action (effect, pure). `pure` could also be called update, like in Elm
//        or simply use a higher-order function like compose : {START : compose (effect, pure)}
//        The advantage of using one's own constructor is that it can be instrumented for tracing and debugging purposes
// TODO : check that the action_res received is the action_res expected i.e. keep action_req at hand, and send action_req with action_res
//        also, give a unique ID (time+counter) to the request - so modify to_observable or add a function after it
// TODO : function de/serialize -> allow to save and recreate the state of the FSM
// TODO : write documentation in readme.md - argue use case for HFSM, give roadmap
// TODO : add the possibility to add conditions one by one on a given transition (preprocessing the array beforehand?)
// TODO : entry and exit actions?? annoying as it forces to add up more intermediate state in the internal state machine
// TODO : maybe remove or optionalize the internal state metadata passing in the model
// TODO : also guard against an action res coming not associated with the action_res we are expecting
//{from: states.cd_loaded_group, to: states.cd_stopped, event: cd_player_events.NEXT_TRACK, condition: is_last_track, action: stop},
//{from: states.cd_loaded_group, to: states.history.cd_loaded_group, event: cd_player_events.NEXT_TRACK, condition: is_not_last_track, action: go_next_track},
////vs. {from: states.cd_loaded_group, to: states.cd_stopped, event: cd_player_events.NEXT_TRACK, conditions: [
////      {condition: is_last_track, to: states.cd_stopped, action: stop},
////      {condition: is_not_last_track, to: states.history.cd_loaded_group, action: go_next_track}
////    ]},
// TODO : Add termination connector (T)?
// TODO : abstract the tree traversal for the build states part
// TODO : DSL
// TODO : write program which takes a transition specifications and draw a nice graph out of it with yed or else
// TODO : think about the concurrent states (AND state
// NOTE : AND states gives problems of processing events (an action_res can be received by several states)
//        so 1 AND state could have received its action result and move on, while the second is still waiting for an action res to come...

// TERMINOLOGY
// Reminder : there are two kinds of intents : user generated intent, and program generated intent
// Reminder : there are two kinds of sources : intents and effect responses (or results, terminology still in flux)
// Terminology :
// - thereafter we refer by FSM (or inner FSM) the finite state machine whose specs is passed as parameter to the state machine
// builder
// - we refer by internal/outer FSM the finite state machine used to build the state machine builder

// NOTE : Dead states:
// - Possible if automatic actions (no events) with conditions always true. If there is not another condition which at some
// point is set to false, we have an infinite loop (a very real one which could monopolize the CPU if all actions are synchronous)
// - To break out of it, maybe put a guard that if we remain in the same state for X steps, transition automatically (to error or else)

// Implementation contracts
// CONTRACT :Actions cannot return an object of type error if not error (check code again)
// CONTRACT : event handlers and predicates MUST be pure (they will be executed several times with the same input)
// CONTRACT : guards/predicates cannot throw (not detected for now, but I should try to catch it and emit fatal error)
// CONTRACT : some events are reserved init,auto,and another one

// Serialization mechanism :
// - Model should come with a serialize method
// - Internal model should come with a serialize method
// - How to serialize the states?? the states should be reproducible via calling the build_states function and then
//   - serialize the inner parameters
// This will allow to save a copy of a state machine and its state for testing.

// CONTRACT : the fsm, after emitting an effect request, blocks till it received the corresponding effect response
// TODO : have another format for effect responses?? so the user cannot have events that could be mistaken for effect responses
// We already have a different format as those events comes from another channel. That channel has to be hidden to avoid
// having other agents sending effect_res to it!! and the internal details not disclosed (in the public documentation)

define(function (require) {
    var utils = require('utils');
    var Err = require('custom_errors');
    var Rx = require('rx');
    var _ = require('lodash');
    var synchronous_fsm = require('synchronous_standard_fsm');
    var outer_fsm_def = require('outer_fsm_def');
    var constants = require('constants');
    var fsm_helpers = require('fsm_helpers');

    return require_async_fsm(synchronous_fsm, outer_fsm_def, fsm_helpers, Rx, Err, utils, constants);
});

function require_async_fsm(synchronous_fsm, outer_fsm_def, fsm_helpers, Rx, Err, utils, constants) {

    // CONSTANTS
    // !!must be the function name for the constructor State, i.e. State
    const STATE_PROTOTYPE_NAME = constants.STATE_PROTOTYPE_NAME;
    const ACTION_IDENTITY = constants.ACTION_IDENTITY;
    const INITIAL_STATE_NAME = constants.INITIAL_STATE_NAME;
    const EV_CODE_TRACE = constants.EV_CODE_TRACE;
    const EV_CODE_AUTO = constants.EV_CODE_AUTO;
    const EV_CODE_INIT = constants.EV_CODE_INIT;
    const EV_INTENT = constants.EV_INTENT;
    const EV_EFFECT_RES = constants.EV_EFFECT_RES;
    const EV_TRACE = constants.EV_TRACE;

    function make_intent(code, payload) {
        return {code: code, payload: payload}
    }

    /**
     * Processes the hierarchically nested states and returns miscellaneous objects derived from it:
     * `is_group_state` : {Object<String,Boolean>} Hash whose properties (state names) are matched with whether that state is a nested state
     * `hash_states` : Hierarchically nested object whose properties are the nested states.
     * - Nested states inherit (prototypal inheritance) from the containing state.
     * - Holds a `history` property which holds a `last_seen_state` property which holds the latest state for that hierarchy group
     *   For instance, if A < B < C and the state machine leaves C for a state in another branch,
     *   then `last_seen_state` will be set to C for A, B and C
     * - Holds an `active` property which is not so useful so far, and which signal whether the state is active (current) or not
     * - Tthe root state (NOK) is added to the whole hierarchy, i.e. all states inherit from the root state
     * `states` {Object<String,Boolean>} : Hash which maps every state name with itself
     * `states.history` {Object<String,Function>} : Hash which maps every state name with a function whose name is the state name
     * @param states
     * @returns {{hash_states: {}, is_group_state: {}}}
     */
    function build_nested_state_structure(states_) {
        var root_name = 'State';
        var last_seen_state_event_emitter = new Rx.Subject();
        var hash_states = {};
        var last_seen_state_listener_disposables = [];
        var is_group_state = {};

        // Add the starting state
        states = {nok: states_};

        ////////
        // Helper functions
        function add_last_seen_state_listener(child_name, parent_name) {
            last_seen_state_listener_disposables.push(
                last_seen_state_event_emitter.subscribe(function (x) {
                    var event_emitter_name = x.event_emitter_name;
                    var last_seen_state_name = x.last_seen_state_name;
                    if (event_emitter_name === child_name) {
                        console.log(['last seen state set to', utils.wrap(last_seen_state_name), 'in', utils.wrap(parent_name)].join(" "));
                        hash_states[parent_name].history.last_seen_state = last_seen_state_name;
                    }
                }));
        }

        function build_state_reducer(states, curr_constructor) {
            Object.keys(states).forEach(function (state_name) {
                var state_config = states[state_name];
                var curr_constructor_new;

                // The hierarchical state mechanism is implemented by reusing the standard Javascript prototypal inheritance
                // If A < B < C, then C has a B as prototype which has an A as prototype
                // So when an event handler (transition) is put on A, that event handler will be visible in B and C
                hash_states[state_name] = new curr_constructor();
                hash_states[state_name].name = state_name;
                var parent_name = hash_states[state_name].parent_name = utils.get_fn_name(curr_constructor);
                hash_states[state_name].root_name = root_name;
                hash_states[state_name].history = {last_seen_state: null};
                hash_states[state_name].active = false;

                // Set up the listeners for propagating the last seen state up the prototypal chain
                // Prototypal inheritance only works in one direction, we need to implement the other direction by hand
                // if A < B < C is a state hierarchy, to implement correctly the history mechanism, we need the last seen state
                // to be the same throughout the whole hierarchy. Prototypal inheritance does not help here as it works in
                // the opposite direction.
                // So we resort to an event emitter (here an RxJS subject) which connect C and B, B and A.
                // When state C is abandoned, then it updates it `last_seen_state` property and emits a change event,
                // B is subscribed to it, and updates its property and emits a change.
                // A is subscribed to B changes, so that the change event is propagated recursively up the hierarchy.
                // This is a reactive mechanim which is simpler that the interactive one where you adjust the whole hierarchy
                // when state C is abandoned.
                add_last_seen_state_listener(state_name, parent_name);

                if (typeof(state_config) === 'object') {
                    is_group_state[state_name] = true;
                    eval(['curr_constructor_new = function', state_name, '(){}'].join(" "));
                    curr_constructor_new.name = state_name;
                    curr_constructor_new.prototype = hash_states[state_name];
                    build_state_reducer(state_config, curr_constructor_new);
                }
            })
        }

        function State() {
            this.history = {last_seen_state: null};
        }

        // The `emit_last_seen_state_event` is set on the State object which is inherited by all state objects, so it can be
        // called from all of them when a transition triggers a change of state
        State.prototype = {
            emit_last_seen_state_event: function (x) {
                last_seen_state_event_emitter.onNext(x);
            },
            current_state_name: INITIAL_STATE_NAME
        };

        hash_states[INITIAL_STATE_NAME] = new State();
        hash_states[STATE_PROTOTYPE_NAME] = new State();

        build_state_reducer(states, State);

        return {
            hash_states: hash_states,
            is_group_state: is_group_state
        };
    }

    function compute_fsm_initial_state(state_chart) {
        // Create the nested hierarchical
        var states = state_chart.state_hierarchy;
        var events = state_chart.events;
        var special_actions = {identity: ACTION_IDENTITY};
        var transitions = state_chart.transitions;
        var hash_states_struct = build_nested_state_structure(states);
        // {Object<state_name,boolean>}, allows to know whether a state is a group of state or not
        var is_group_state = hash_states_struct.is_group_state;
        var hash_states = hash_states_struct.hash_states;

        // {Object<state_name,boolean>}, allows to know whether a state has a init transition defined
        var is_init_state = get_init_transitions(transitions);

        // {Object<state_name,boolean>}, allows to know whether a state has an automatic transition defined
        var is_auto_state = get_auto_states(transitions, events, is_group_state, is_init_state);

        set_event_handlers(transitions, /*OUT*/hash_states, special_actions);

        var model_0 = state_chart.model || {};

        return {
            model: utils.clone_deep(model_0), // clone the initial value of the model
            is_init_state: is_init_state,
            is_auto_state: is_auto_state,
            is_group_state: is_group_state,
            hash_states: hash_states,
            internal_state: {
                expecting: constants.EXPECTING_INTENT,
                is_model_dirty: true,
                from: undefined,
                to: undefined
            },
            payload: undefined,
            effect_req: undefined,
            recoverable_error: undefined,
            automatic_event: undefined
        };

        function get_init_transitions(transitions) {
            var is_init_state = {};
            transitions.forEach(function (transition) {
                var from = transition.from;
                var event = transition.event;

                // CASE : transition has a init event
                // NOTE : there should ever only be one, but we don't enforce it for now
                if (event === EV_CODE_INIT) {
                    is_init_state[from] = true;
                }
            });
            return is_init_state;
        }

        function get_auto_states(transitions, events, is_group_state, is_init_state) {
            return transitions.reduce(function (is_auto_state, transition) {
                var from = transition.from;
                var event = transition.event;

                // ERROR CASE : state found in transition but cannot be found in the events passed as parameter
                // NOTE : this is probably all what we need the events variable for
                if (event && !(event in events)) throw 'unknow event (' + event + ') found in state machine definition!';
                // CASE : automatic transitions : no events - likely a transient state with only conditions
                if (!event) {
                    event = EV_CODE_AUTO;
                    is_auto_state[from] = true;
                }
                // CASE : automatic transitions : init event automatically fired upon entering a grouping state
                if (is_group_state[from] && is_init_state[from]) {
                    is_auto_state[from] = true;
                }
                return is_auto_state;
            }, {});
        }

        function set_event_handlers(transitions, /*OUT*/hash_states, special_actions) {
            transitions.forEach(function (transition) {
                // console.log("Processing transition:", transition);
                var from = transition.from, to = transition.to;
                var action = transition.action;
                var event = transition.event || EV_CODE_AUTO;

                // CONTRACT : `conditions` property used for array of conditions, otherwise `condition` property is used
                var arr_predicate = transition.guards || transition.predicate;
                // CASE : ZERO OR ONE condition set
                if ((arr_predicate && !arr_predicate.forEach) || !arr_predicate) arr_predicate = [
                    {predicate: arr_predicate, to: to, action: action    }
                ];

                var from_proto;
                from_proto = hash_states[from];

                //console.log("This is transition for event:", event);
                //console.log("Predicates:", arr_predicate);

                from_proto[event] = arr_predicate.reduce(function (acc, guards, index) {
                    var action = guards.action;
                    var condition_checking_fn = (function (guards) {
                        var condition_suffix = '';
                        // We add the `current_state` because the current state might be different from the `from` field here
                        // This is the case for instance when we are in a substate, but through prototypal inheritance it is
                        // the handler of the prototype which is called
                        var condition_checking_fn = function (model_, event_data, current_state) {
                            from = current_state || from;
                            var predicate = guards.predicate;
                            condition_suffix = predicate ? '_checking_condition_' + index : '';
                            var to = guards.to;
                            if (!predicate || predicate(model_, event_data)) {
                                // CASE : condition for transition is fulfilled so we can execute the actions...
                                utils.info("IN STATE ", from);
                                utils.info("WITH model, event data BEING ", model_, event_data);
                                utils.info("CASE : "
                                    + (predicate ? "predicate " + predicate.name + " for transition is fulfilled"
                                        : "automatic transition"));

                                return action
                                    // allows for chaining and stop chaining condition
                                    ? {effect_code: action, from: from, to: to}
                                    // CASE : I have a condition which is fulfilled but no action
                                    // so, the model does not change, but the transition should happen
                                    : {effect_code: special_actions.identity, from: from, to: to};
                            }
                            else {
                                // CASE : condition for transition is not fulfilled
                                console.log("CASE : "
                                    + (predicate ? "predicate " + predicate.name + " for transition NOT fulfilled..."
                                        : "no predicate"));
                                return {effect_code: undefined, from: from, to: to};
                            }
                        };
                        condition_checking_fn.displayName = from + condition_suffix;
                        return condition_checking_fn;
                    })(guards);

                    return function arr_predicate_reduce_fn(model_, event_data, current_state) {
                        var condition_checked = acc(model_, event_data, current_state);
                        return condition_checked.effect_code
                            ? condition_checked // would be the effect code to interpret
                            : condition_checking_fn(model_, event_data, current_state);
                    }
                }, function default_predicate() {
                    return {effect_code: undefined, from: from}
                });
            });
        }
    }

    function outer_fsm_write_trace(traceS, /*OUT*/fsm_state, internal_fsm_def, internal_event_type, internal_event, evaluation_result) {
        // This function will update the `fsm_state` variable with trace information if the trace flag is set
        var emit_traces = true;
        var should_trace = fsm_state.is_tracing;
        if (should_trace) {
            // Reminder : Array Trace, where
            // Trace :: (Event, State, Model, Optional Time_Info), where
            // Event :: (Event_Type, Event_Data)
            // State :: State_Enum
            // Model :: Serializable

            // Tracing is complicated by the fact that the trace information which we want and which is that of the
            // specified HFSM is scattered among states of the internal FSM
            // In short, when internal FSM in state :
            // - expecting_intent : we have code and payload corresponding to the intent, with internal_type being 'intent'
            //                      `resulting_state` and `timestamp` being not relevant, together with the model
            //                      which has not been modified yet
            // - expection_action_result :now we have `resulting_state` and `timestamp` relevant and the model too
            // So: depending on the internal state we pick certain fields and accumulate them in a full trace record
            var internal_fsm_events = internal_fsm_def.events;
            var arr_traces = fsm_state.arr_traces;
            var resulting_state = outer_fsm_def.get_current_state(fsm_state);
            var fsm_state_update = evaluation_result.fsm_state_update;
            var model_update = fsm_state_update.model;
            var recoverable_error = evaluation_result.recoverable_error;

            // We need to clone the model before passing it to the trace, so the trace reflects the value of the model
            // at the moment of the trace (no impact of further modifications to the model)
            // `code` and `resulting_state` and `time_stamp` should not be deep cloned, as they are primitive types
            // Those details are particular to the model, so we have utils.clone_deep using the `clone_deep` model version
            // if it exists
            // NOTE : The model passed here has already been updated previously with model_update
            var model = utils.clone_deep(fsm_state.model);

            // If we receive a trace event, do not trace it, only trace non-trace event, i.e. intent and effect results
            if (internal_event_type === internal_fsm_events.EV_INTENT) {
                if (recoverable_error) {
                    add_trace_record(add_recoverable_error_to_trace_record(model, model_update, recoverable_error),
                        /*OUT*/arr_traces, traceS, emit_traces);
                }
                else {
                    arr_traces.push({
                        event: {code: internal_event.code, payload: utils.clone_deep(internal_event.payload)}
                    });
                }
            }
            if (internal_event_type === internal_fsm_events.EV_EFFECT_RES) {
                // TODO : deal with error when effect_res
                update_trace_record(complete_trace_record, /*OUT*/arr_traces,
                    recoverable_error, resulting_state, model, model_update, traceS, emit_traces);
            }
        }

        // arr_traces is modified in place, however we return it just in case we need the value for chaining or else
        return arr_traces;
    }

    /**
     * Side-effects:
     * - possibly emits a message on the trace subject
     * - modifies fsm_state
     * @param update_fn
     * @param fsm_state
     * @param traceS
     * @returns
     */
    function update_trace_record(update_fn, /*OUT*/arr_traces, recoverable_error, resulting_state, model, model_update, traceS, emit_traces) {
        emit_traces = (typeof(emit_traces) === 'boolean') ? emit_traces : true;
        var incomplete_record = arr_traces.pop();
        var completed_trace_record = update_fn(incomplete_record, recoverable_error, resulting_state, model, model_update);
        arr_traces.push(completed_trace_record);
        emit_traces && traceS.onNext(arr_traces);
    }

    function add_trace_record(add_fn, /*OUT*/arr_traces, traceS, emit_traces) {
        emit_traces = (typeof(emit_traces) === 'boolean') ? emit_traces : true;
        add_fn(/*OUT*/arr_traces);
        emit_traces && traceS.onNext(arr_traces);
    }

    function add_recoverable_error_to_trace_record(model, model_update, recoverable_error) {
        return function (/*OUT*/arr_traces) {
            arr_traces.push({
                model: utils.clone_deep(model),
                model_update: model_update || {},
                recoverable_error: recoverable_error
            });
            return arr_traces;
        }
    }

    function complete_trace_record(/*OUT*/record, recoverable_error, resulting_state, model, model_update) {
        record.resulting_state = resulting_state;
        record.model = model;
        record.model_update = model_update || {};
        record.timestamp = utils.get_timestamp();
        recoverable_error && (record.recoverable_error = recoverable_error);
        return record;
    }

    /////////
    // Event handler (for all events) for the synchronous state machine which builds the asynchronous state machine

    /**
     * Curried function which takes a state machine definition and returns a function which allow to operate that state machine
     * @param fsm_def {State_Machine_Definition} where
     * - State_Machine_Definition :: Hash {states :: State_Definitions, transitions :: Transitions}, where
     *   - State_Definitions :: Hash { State_Identifier -> State_Definition } where
     *     - State_Identifier :: String
     *     - State_Definition :: Hash { entry :: Function, exit :: Function}
     *     - FOR NOW not used
     *   - Transitions :: Hash { State_Identifier -> Hash { Event_Identifier -> Array<Transition> }} where
     *     - Transition :: Hash {predicate :: T -> E -> Boolean, action :: T -> E -> T, to :: State_Identifier}, where
     *       - E is a type representing an event (also named input symbol in the state machine terminology)
     *       - T is any non-trivial type which represent the data associated with the event
     *
     * @returns {process_fsm_internal_transition}
     * Side-effects :
     * - traceS property updated with the latest value of the array of traces
     */
    function process_fsm_internal_transition(fsm_def, fsm_write_trace, traceS) {
        // NOTE : for this synchronous state machine, the algorithm is pretty simplified :
        // - we do not need to separate action codes and action functions
        // - we do not need to wait for an action to return, as it returns immediately
        // - we removed the need to have an event enumeration by mapping the event object to the event type in one hashmap
        //   (we could actually do that too for the async. case I suppose)
        // -> Hence, all the input necessary to define the synchronous state machine are the states, and the transitions
        //    If we do not have entry/exit actions, we do not even need to hold the state information in one separate
        //    structure
        /**
         * Updates the state machine (available in the currying function closure) state by evaluation the transitions
         * available in the current state vs. the internal event (`merged_labelled_input`) passed as parameter
         * @param fsm_state {T} where :
         * - T represents the extended state (that we will refer to as model for lack a better term)
         *   managed by the internal state machine
         * - Here a `variable :: T` will have the controlled state (i.e. the proper state) of the internal state machine in
         *   `variable.internal_state.expecting`
         *   - This represents the type of input expected by the internal state machine, either effect response or user intent
         *
         * @param merged_labelled_input {Cycle_FSM_Input} where :
         * - Cycle_FSM_Input :: Hash { Event_Identifier -> E }
         * Here, E ::
         * - case Event_Identifier
         *   - 'intent' : Hash {code :: String, payload : Object}
         *   - 'effect_res' : Object
         *
         * Side-effects:
         * - fsm_state is updated according to the inner and outer transition taken
         */
        return function process_fsm_internal_transition(fsm_state, merged_labelled_input) {
            ////////////
            // Helper functions

            ////////////
            //
            var fsm_internal_states = fsm_def.states;
            var fsm_internal_transitions = fsm_def.transitions;
            var fsm_current_internal_state = fsm_state.internal_state.expecting;
            // Event format : {event_type : event}
            // `merged_labelled_input` should only have one key, which is the event type
            var internal_event_type = Object.keys(merged_labelled_input)[0];
            // the actual event has the following shape according to the event type:
            // intent -> {code, payload}, action_res -> Object
            var internal_event = merged_labelled_input[internal_event_type];

            var evaluation_result = synchronous_fsm.evaluate_internal_transitions(
                fsm_internal_states,
                synchronous_fsm.get_internal_transitions(fsm_internal_transitions, fsm_current_internal_state, internal_event_type),
                /*OUT*/fsm_state, internal_event
            );
            if (evaluation_result.fatal_error) {
                throw evaluation_result.fatal_error;
            }
            else {
                var fsm_state_update = evaluation_result.fsm_state_update;
                var model_update = fsm_state_update.model;
                update_fsm_state(/*OUT*/fsm_state, fsm_state_update);
                fsm_write_trace(traceS, fsm_state, fsm_def, internal_event_type, internal_event, evaluation_result);

                return fsm_state;
            }
        }
    }

    function update_fsm_state(model, model_update) {
        // in-place update of the model
        return utils.merge(model, model_update);
    }

    /**
     * TODO : redocument the function
     * - transition format
     *   - events : if not present, then actions become automatic
     *   - condition(s) : if several, pass them in an array (field `conditions`), the order of the array is the order
     *                    of applying the conditions. When a single condition (field `condition`)
     *                    When the first is found true, the sequence of condition checking stops there
     *   - action : function (model, event_data) : model_prime
     *   - from : state from which the described transition operates
     *   - to : target state for the described transition
     * @param state_chart
     * @param user_generated_intent$
     * @param effect_res$
     * @param program_generated_intent$
     * @param trace_intentS
     * @returns {{fsm_state${Rx.Observable}, effect_req${Rx.Observable}}
 */
    function transduce_fsm_streams(state_chart, user_generated_intent$, effect_res$, program_generated_intent$, trace_intentS) {
        // TODO : put as a constant all the 'effect_req', 'trace' etc. (becomes hidden dependency otherwise)

        // Build the sinks :
        // - there are three source origins:
        //   - intents : they divide into user intents and automatic actions (program generated intents) from the state machine
        //   - effect results : they are the eventual return value from executing effects
        //   - trace : contain the information allowing to toggle the tracing mechanism

        // Traces array, represented as an observable property (behavior)
        // Will be updated whenever the array of traces is updated
        var traceS = new Rx.BehaviorSubject([]);

        var fsm_initial_state = compute_fsm_initial_state(state_chart);

        var outer_fsm = outer_fsm_def.get_internal_sync_fsm();

        var merged_labelled_sources$ = Rx.Observable.merge(
            Rx.Observable.merge(user_generated_intent$, program_generated_intent$).map(utils.label(EV_INTENT)),
            effect_res$.map(utils.label(EV_EFFECT_RES)),
            trace_intentS.map(utils.label(EV_TRACE))
        )
            .do(function (x) {
                utils.rxlog(utils.get_label(x))(x[Object.keys(x)[0]]);
            });

        var fsm_state$ = merged_labelled_sources$
            .scan(process_fsm_internal_transition(outer_fsm, outer_fsm_write_trace, traceS), fsm_initial_state)
            .catch(function (e) {
                var returnValue;
                console.error('error while process_fsm_internal_transition', e);
                return Rx.Observable.throw(e);
            })
            .shareReplay(1)// test to remove it to see if it makes a difference, share should be enough I think

        // The stream of effect requests
        var effect_req$ = fsm_state$
            .filter(utils.get_prop('effect_req'))
            .map(function (fsm_state) {
                return {
                    effect_req: fsm_state.effect_req,
                    model: fsm_state.model,
                    payload: fsm_state.payload
                };
            })
            .do(utils.rxlog('effect req$'))
            .publish();

        // The stream of model updates
        // Can be anything that the function `update_model` understands
        var model_update$ = fsm_state$
            .filter(function filter_in_new_model(fsm_state) {
                return !utils.is_empty(fsm_state.model_update);
            })
            .pluck('model_update')
            .startWith(fsm_initial_state.model)
            .do(utils.rxlog('new model update emitted'));

        // The model passed out by the stream should be read-only.
        // Possible downstream write-effects are disarmed by deep cloning.
        // This ensures that the model is modified only here.
        var model$ = fsm_state$
            .pluck('model')
            .map(utils.clone_deep)
            .do(utils.rxlog('new model emitted'));

        // Intents generated internally (automatic actions)
        var program_generated_intent_req$ = fsm_state$
            .filter(utils.get_prop('automatic_event'))
            .pluck('automatic_event')
            .startWith({
                code: EV_CODE_INIT,
                payload: fsm_initial_state.model
            })
            .do(utils.rxlog('program_generated_intent_req$'))
            .publish();

        return {
            fsm_state$: fsm_state$,
            model_update$: model_update$, // object representing the updates to do on the current model
            model$: model$, // the updated model
            effect_req$: effect_req$,
            program_generated_intent_req$: program_generated_intent_req$,
            trace$: traceS
        }
    }

    function make_fsm(state_chart, user_generated_intent$) {
        var effect_req_disposable, program_generated_intent_req_disposable;
        var effect_resS = new Rx.ReplaySubject(1);
        var program_generated_intentS = new Rx.ReplaySubject(1);
        var effect_hash = state_chart.action_hash;
        var trace_intentS = new Rx.ReplaySubject(1);
        var final_trace = [];
        var debug_intentS = new Rx.ReplaySubject(1);
        var fsm_sinks = transduce_fsm_streams(state_chart,
            Rx.Observable.merge(user_generated_intent$, debug_intentS),
            effect_resS, program_generated_intentS,
            trace_intentS
        );
        var trace$ = fsm_sinks.trace$
            .takeUntil(trace_intentS.filter(is_trace_intent_false))
            .finally(utils.rxlog('ending tracing'))
            .share();
        var final_traceS = new Rx.AsyncSubject();

        function start() {
            // Connecting requests streams to responses
            effect_req_disposable = make_effect_handler_operator(effect_hash)(fsm_sinks.effect_req$)
                .subscribe(effect_resS);
            program_generated_intent_req_disposable = fsm_sinks.program_generated_intent_req$
                .subscribe(program_generated_intentS);
            fsm_sinks.effect_req$.connect(); // NOTE : ORDER HERE IS IMPORTANT!!
            fsm_sinks.program_generated_intent_req$.connect();
        }

        function stop() {
            // NOTE : once stopped the state machine cannot be restarted... maybe destroy is a better name?
            dispose(effect_req_disposable);
            dispose(program_generated_intent_req_disposable);
            dispose(trace_intentS);
        }

        function dispose(subject) {
            subject.onCompleted();
            subject.dispose();
        }

        // Trace mechanism
        //
        // - Activation and deactivation
        //   The behaviour of the state machine can be traced. This is particularly helpful for testing purposes, but should be
        //   avoided anywhere performance matters, as the tracing slows down the execution of the state machine.
        //   The tracing process is as is :
        //
        //   - activate the trace mechanism : `fsm.start_trace()`
        //     From that moment on, every expected processing step of the state machine will result in a trace record inserted
        //     in a trace array.
        //   - deactivate the trace mechanism : `fsm.stop_trace()`
        //     From that moment on, the state machine is no longer traced on. The state machine produces the array of traces via
        //     an observable which output only one value, and must be subscribed with a trace handler which receive the trace array
        //     : `fsm.trace$.subscribe(trace_handler)`
        //
        // - Event simulation
        //   To have the state machine react to a given event provoked by the user, a helper method is available :
        //   `fsm.send_event :: Event -> ()`
        //   NOTE : When sending sequences of events, be careful to pace them appropriately so the next event comes
        //          after the previous event is finished being processed.
        //
        // - Type information
        // traces :: [Trace] where
        //   Trace :: Hash {event :: Event, model :: Model, resulting_state :: State_Enum, time_stamp :: Date} |
        //            Hash {event :: Event, model :: Model, resulting_state :: State_Enum, recoverable_error :: Recov_Error, time_stamp :: Date}
        //   where :
        //     Event :: Hash {code :: Event_Enum, payload :: Any}
        //     State_Enum :: String_Identifier
        //     Model (implements cloneable, serializable) :: Any
        //     Recov_Error :: Hash {error :: Error, resulting_state :: State_Enum, event :: Event_Enum, event_data :: Any}
        // If no error occured during an execution step of the state machine, Trace format does not have an error field
        // If a recoverable error occured, Trace format does have a `recoverable_error` field
        // If a fatal error occurred, the application is possibly abruptly exited, and no trace records are available at all
        function start_trace() {
            // Sends a program-generated event to start the tracing mechanism
            // Subscribe an async subject to the trace observable so that only one value, the last one is kept
            // That value is the (last) array of traces
            trace_intentS.onNext(make_intent(EV_CODE_TRACE, true));
            trace$.subscribe(final_traceS);
        }

        function stop_trace() {
            trace_intentS.onNext(make_intent(EV_CODE_TRACE, false));
        }

        function is_trace_intent_false(x) {
            return !x.payload;
        }

        function send_event(code, payload) {
            // NOTE : debug_intent has same format as user_generated_intent i.e. {code, payload}
            debug_intentS.onNext({code: code, payload: payload});
        }

        return {
            start: start,
            stop: stop,
            model$: fsm_sinks.model$.share(), // defensively share the model in case it is subscribed several times over
            model_update$: fsm_sinks.model_update$.share(),
            // TODO : can be exposed as a living trace of the state of the system instead of modifying the model with meta properties
            fsm_state$: fsm_sinks.fsm_state$,
            trace$: final_traceS, // by subscribing to trace$, only one value will be output, the array of traces recorded
            start_trace: start_trace,
            stop_trace: stop_trace,
            send_event: send_event,
            serialize: utils.nok, // TODO
            deserialize: utils.nok, // TODO
            set_internal_state: fsm_sinks.set_internal_state, // TODO but should be used only for testing
            get_internal_state: fsm_sinks.get_internal_state // TODO but should be used only for testing
        }
    }

    function make_effect_handler_operator(effect_hash) {
        // An effect is a function :: model -> event_data -> model
        // 1. From the function list, we derive an enumeration from the function names
        //    By construction there cannot be two functions with the same name
        //    The function names will serve as the DSL to represent the actions
        // The resulting DSL is generated to serve as input to the main
        // effect_req maker
        return function effect_req_interpreter(effect_req$) {
            // 1. Look up effect_req in list of actions
            // 2. If not there, return error code or send error through subject
            // 3. If there, then execute the action
            var effect_res$ = effect_req$
                .flatMap(function (effect_req) {
                    var effect_payload = effect_req.payload;
                    var effect_enum = effect_req.effect_req;
                    var model = effect_req.model;
                    var effect = effect_hash[effect_enum];
                    if (effect) {
                        // CASE : we do have some actions to execute
                        var effect_res = Err.tryCatch(function execute_effect(effect, effect_payload) {
                            console.info("THEN : we execute the effect " + effect.name);
                            return effect(model, effect_payload);
                        })(effect, effect_payload);
                        if (effect_res instanceof Error) {
                            return Rx.Observable.return(effect_res);
                        }
                        else return utils.to_observable(effect_res);
                    }
                    else {
                        // TODO : be careful, they say flatMap swallow errors, That should be a fatal error
                        return Rx.Observable.throw('no effect found for effect code ' + effect_enum);
                    }
                });
            return effect_res$;
        }
    }

    return {
        make_fsm: make_fsm,
        transduce_fsm_streams: transduce_fsm_streams,
        process_fsm_internal_transition: process_fsm_internal_transition,
        //        create_state_enum: create_state_enum,
        //        create_event_enum: create_event_enum,
        //        make_action_DSL: make_action_DSL
    }
}

// TODO : rewrite the action driver to actually have a transducer for each type of operation and pass the stream to that transducer
// operator let??
