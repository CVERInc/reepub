import SwiftUI

@main
struct ReepubApp: App {
    @StateObject private var loc = Localizer()

    var body: some Scene {
        WindowGroup("Reepub") {
            ContentView(loc: loc)
                .environmentObject(loc)
        }
        .windowStyle(.hiddenTitleBar)
        .windowResizability(.contentSize)
    }
}
