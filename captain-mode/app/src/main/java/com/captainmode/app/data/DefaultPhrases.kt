package com.captainmode.app.data

object DefaultPhrases {

    val library = PhraseLibrary(
        attention = listOf(
            "Ladies and gentlemen, this is your Captain speaking.",
            "Attention ladies and gentlemen, this is your Captain speaking.",
            "Good {daypart}, ladies and gentlemen, from the flight deck — this is your Captain.",
            "Ladies and gentlemen, from the cockpit — your Captain speaking.",
            "{greeting}, ladies and gentlemen — this is your Captain.",
            "Cabin crew, this is the Captain — and a warm welcome to everyone on board."
        ),
        welcome = listOf(
            "Welcome aboard {airline}, non-stop service to your destination.",
            "On behalf of the entire crew, welcome aboard {airline}.",
            "Welcome aboard this {daypart}'s service with {airline}.",
            "Welcome aboard {car}, flying today under the {airline} banner.",
            "It's a pleasure to have you with us on {airline} today.",
            "Thank you for choosing {airline} — welcome aboard."
        ),
        weatherReport = listOf(
            "Current conditions: {weather}, {temp} degrees outside.",
            "Weather along our route today is {weather}, with an outside temperature of {temp} degrees.",
            "It's {temp} degrees out there with {weather}.",
            "Our reports show {weather} and {temp} degrees this {daypart}.",
            "Looking outside, we have {weather} — {temp} degrees at ground level."
        ),
        rideForecast = mapOf(
            Condition.CLEAR to listOf(
                "We're expecting a smooth ride today, so sit back, relax, and enjoy the journey.",
                "Clear skies ahead — it should be an exceptionally smooth ride.",
                "Conditions are ideal, and we anticipate smooth air the whole way.",
                "A perfect day to fly — expect a calm and comfortable ride."
            ),
            Condition.CLOUDS to listOf(
                "A few clouds along the route, but we're expecting a comfortable ride throughout.",
                "Slightly overcast today — nothing that will trouble our journey.",
                "Some cloud cover ahead, but the ride should stay nice and smooth.",
                "Grey skies, smooth air — a routine flight ahead."
            ),
            Condition.RAIN to listOf(
                "We may encounter a few showers en route — wipers are on standby, and we'll keep the seatbelt sign on.",
                "Rain along the route today, so we'll take it steady — a little extra braking distance never hurt anyone.",
                "Wet conditions out there. The crew advises caution on the taxiways, and we'll keep things smooth.",
                "Showers reported ahead — we'll be flying through them with care, so keep your seatbelt fastened."
            ),
            Condition.WIND to listOf(
                "Gusty winds out there, so we're expecting light turbulence along the route — nothing this aircraft can't handle.",
                "It's a blustery one today. Expect the occasional bump, and keep your seatbelt fastened while seated.",
                "Crosswinds reported on our route — we may experience light chop, but it should settle down shortly.",
                "A windy {daypart} — light turbulence expected, so hold on to your coffee."
            ),
            Condition.FOG to listOf(
                "We're looking at fog and reduced visibility, so we'll be operating under instrument conditions — a slightly slower departure today.",
                "Low visibility this {daypart}. We'll take it steady and trust the instruments.",
                "Fog on the field — extra caution ahead, and we appreciate your patience.",
                "Visibility is limited out there, so we'll be flying by instruments. Sit back and leave it to us."
            ),
            Condition.SNOW to listOf(
                "Snow along our route today — de-icing complete, and we'll be taking it nice and steady.",
                "Winter operations in effect. The going may be slow, but we'll get you there safely.",
                "Snowy conditions out there — extra stopping distance today, and the seatbelt sign stays on.",
                "A white {daypart} ahead — beautiful to look at, careful to drive through."
            ),
            Condition.STORM to listOf(
                "Stormy weather on our route — we'll be navigating with extra care, so keep your seatbelt securely fastened.",
                "Rough weather advisory in effect. Expect turbulence, and please remain seated for the duration.",
                "Thunderstorms reported ahead — we'll pick the smoothest path available and keep you informed.",
                "It's a wild one out there. All systems are ready, and we'll take the safest route through."
            )
        ),
        traffic = listOf(
            "Reports indicate heavy traffic on the taxiways ahead, so please bear with us during today's departure.",
            "It's rush hour on the ground — expect some congestion before we reach cruising speed.",
            "Ground control reports busy routes this {daypart} — we'll keep the delays to a minimum.",
            "Heavy traffic ahead — a good moment to sit back and enjoy the cabin service."
        ),
        signOff = listOf(
            "Cabin crew, prepare for departure.",
            "Crosscheck complete, and we are cleared for pushback.",
            "Sit back, relax, and leave the flying to us.",
            "Estimated time of departure: right now. Enjoy the flight.",
            "Doors to automatic, crosscheck complete — let's fly.",
            "We are cleared for departure. Have a pleasant journey."
        ),
        disconnect = listOf(
            "Ladies and gentlemen, we have arrived. On behalf of {airline}, thank you for flying with us today.",
            "Welcome to your destination. We know you have a choice of airlines, and we're glad you chose {airline}.",
            "This concludes today's flight. From all of us at {airline} — take care, and we'll see you on board again soon.",
            "Doors to manual. Thank you for flying {airline} — mind the gap on your way out."
        ),
        specials = listOf(
            SpecialScript(
                id = "night-service",
                label = "Late-night service",
                text = "Good evening, ladies and gentlemen — this is your Captain on this late-night service with {airline}. " +
                        "Conditions outside: {weather}, {temp} degrees, and the routes are quiet at this hour. " +
                        "Expecting an exceptionally smooth ride. Dim the cabin lights, and let's get you home. Cleared for departure.",
                enabled = true,
                days = emptyList(),
                startMinute = 22 * 60,
                endMinute = 5 * 60
            ),
            SpecialScript(
                id = "monday-morning",
                label = "Monday morning launch",
                text = "Good morning, ladies and gentlemen, this is your Captain speaking. It's Monday — the start of another " +
                        "mission week aboard {airline}. Weather report: {weather}, {temp} degrees. All systems are green, " +
                        "the coffee is hot, and we are cleared for departure. Wheels up.",
                enabled = true,
                days = listOf(1),
                startMinute = 5 * 60,
                endMinute = 11 * 60
            )
        )
    )
}
