import com.android.build.gradle.AppExtension
import com.android.build.gradle.AppPlugin
import java.io.File
import java.util.Properties

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

val keystoreProperties = Properties().apply {
    val propFile = file("../keystore.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

fun String?.orProp(default: String): String = this?.takeIf { it.isNotBlank() } ?: default

buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        classpath("com.android.tools.build:gradle:8.11.0")
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:1.9.25")
    }
}

allprojects {
    repositories {
        google()
        mavenCentral()
    }
}

subprojects {
    afterEvaluate {
        plugins.withType<AppPlugin> {
            extensions.configure<AppExtension>("android") {
                val storeFilePath = keystoreProperties.getProperty("storeFile")
                if (!storeFilePath.isNullOrBlank()) {
                    val resolvedStoreFile = if (File(storeFilePath).isAbsolute) {
                        File(storeFilePath)
                    } else {
                        rootProject.file(storeFilePath)
                    }

                    if (resolvedStoreFile.exists()) {
                        signingConfigs {
                            create("release") {
                                storeFile = resolvedStoreFile
                                storePassword = keystoreProperties.getProperty("storePassword").orProp("")
                                keyAlias = keystoreProperties.getProperty("keyAlias").orProp("")
                                keyPassword = keystoreProperties.getProperty("keyPassword").orProp("")
                            }
                        }

                        buildTypes {
                            getByName("release") {
                                signingConfig = signingConfigs.getByName("release")
                            }
                        }
                    } else {
                        logger.warn("Skipping Android signing: keystore not found at ${resolvedStoreFile.path}")
                    }
                }
            }
        }
    }
}