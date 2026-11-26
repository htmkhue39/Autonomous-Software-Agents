/**
 * The PDDL domain of one intention, as on page 12 of the course slides: the
 * agent moves between tiles, picks a parcel up and puts it down on a delivery
 * tile. Every problem uses this same domain; only the problem changes.
 *
 * There is one move action per direction, each following its own edge
 * predicate, so that arrow tiles can allow a move in one direction only.
 */
const DIRECTIONS = ['up', 'down', 'left', 'right'];

export const DOMAIN = `(define (domain deliveroo)
 (:requirements :strips)
 (:predicates (at ?t) ${DIRECTIONS.map(d => `(${d} ?from ?to)`).join(' ')}
  (delivery ?t) (parcel-at ?p ?t) (carrying ?p) (delivered ?p))
${DIRECTIONS.map(d => ` (:action move-${d}
  :parameters (?from ?to)
  :precondition (and (at ?from) (${d} ?from ?to))
  :effect (and (not (at ?from)) (at ?to)))`).join('\n')}
 (:action pickup
  :parameters (?p ?t)
  :precondition (and (at ?t) (parcel-at ?p ?t))
  :effect (and (not (parcel-at ?p ?t)) (carrying ?p)))
 (:action putdown
  :parameters (?p ?t)
  :precondition (and (at ?t) (delivery ?t) (carrying ?p))
  :effect (and (not (carrying ?p)) (delivered ?p))))`;
